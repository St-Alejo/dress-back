import { InjectQueue } from '@nestjs/bullmq';
import { BadRequestException, ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Queue } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { outfitConflict, PHOTO_TTL_HOURS, type OutfitItem, type TryOnMode } from '@vestirse/shared-types';
import { cleanPhoto, type UploadedPhoto } from '../../../common/photo';
import type { Requester } from '../../../common/requester';
import { ObjectStorage } from '../../../common/storage';
import { AiWorkerClient } from '../../ai-settings/ai-settings.module';
import { CatalogRepository } from '../../catalog/application/catalog.repository';
import { MetricsService } from '../../metrics/metrics.module';
import { DomainError, TryOnSession } from '../domain/tryon-session.entity';
import { TryOnSessionRepository } from './tryon-session.repository';

export const GENERATION_QUEUE = 'tryon-generation';
export interface GenerationJob {
  sessionId: string;
}

/**
 * Un reintento (a los 5 s) para fallos transitorios del proveedor. Con dos intentos de
 * GENERATION_TIMEOUT_SECONDS el peor caso ronda los 8 min, por debajo del plazo del cliente.
 * El jobId es idempotente por solicitud: si el mismo pedido se encola dos veces, BullMQ lo ignora.
 */
export function generationJobOptions(sessionId: string, requestedAt: Date) {
  return {
    jobId: `gen-${sessionId}-${requestedAt.getTime()}`,
    attempts: 2,
    backoff: { type: 'exponential' as const, delay: 5_000 },
    removeOnComplete: true,
    removeOnFail: 100,
  };
}

export { MAX_PHOTO_BYTES } from '../../../common/photo';

@Injectable()
export class TryOnService {
  private readonly ttlHours: number;

  constructor(
    private readonly sessions: TryOnSessionRepository,
    private readonly catalog: CatalogRepository,
    private readonly storage: ObjectStorage,
    private readonly metrics: MetricsService,
    private readonly worker: AiWorkerClient,
    @InjectQueue(GENERATION_QUEUE) private readonly queue: Queue<GenerationJob>,
    config: ConfigService,
  ) {
    this.ttlHours = Number(config.get('PHOTO_TTL_HOURS', PHOTO_TTL_HOURS));
  }

  async start(args: { garmentId: string; mode: TryOnMode; bodyModelId?: string; outfit?: OutfitItem[] }, requester: Requester) {
    const ids = [...new Set([args.garmentId, ...(args.outfit ?? []).map((o) => o.garmentId)])];
    const garments = await Promise.all(ids.map((id) => this.catalog.findGarment(id)));
    if (garments.some((g) => !g)) throw new NotFoundException('prenda no encontrada');
    // Una prenda por zona: dos camisas, o vestido y pantalón, no se pueden llevar a la vez.
    if (args.outfit?.length) {
      const conflict = outfitConflict(args.outfit.map((o) => garments[ids.indexOf(o.garmentId)]!.category));
      if (conflict) throw new UnprocessableEntityException(`dos prendas para la misma zona: ${conflict}`);
    }
    const session = this.domain(() => TryOnSession.start({ id: randomUUID(), ...args, requester, now: new Date() }));
    // El uso de modalidad lo reporta el cliente al elegirla; crear la sesión no cuenta dos veces.
    await this.sessions.create(session);
    return session.toDto();
  }

  async get(id: string, requester: Requester) {
    return (await this.owned(id, requester)).toDto();
  }

  async list(requester: Requester) {
    return (await this.sessions.listOwned(requester, 30)).map((s) => s.toDto());
  }

  async changeMode(id: string, mode: TryOnMode, requester: Requester) {
    const session = await this.owned(id, requester);
    session.changeMode(mode);
    await this.sessions.save(session);
    await this.metrics.record('mode-used', { mode, garmentId: session.garmentId });
    return session.toDto();
  }

  /**
   * Sube la foto (Track B). Se re-codifica en el servidor: se aplica la orientación
   * y se descartan TODOS los metadatos (EXIF/GPS), y se limita la resolución.
   */
  async uploadPhoto(id: string, file: UploadedPhoto | undefined, requester: Requester) {
    const clean = await cleanPhoto(file);
    const session = await this.owned(id, requester);

    this.domain(() => session.assertPhotoChangeable());
    const stale = session.purgePhoto();
    if (stale.length) await this.storage.deleteMany(stale);
    this.domain(() => session.attachPhoto(new Date(), this.ttlHours));
    await this.storage.put(session.photoKey!, clean, 'image/jpeg');
    await this.sessions.save(session);
    // Aviso de encuadre (cuerpo entero, una persona, de frente, buena luz). Informa, no rechaza.
    const photoCheck = await this.worker.inspectPhoto(clean);
    return { ...session.toDto(), ...(photoCheck.checked ? { photoCheck } : {}) };
  }

  async requestGeneration(id: string, requester: Requester) {
    const session = await this.owned(id, requester);
    this.domain(() => session.requestGeneration());
    await this.sessions.save(session);
    await this.queue.add('generate', { sessionId: session.id }, generationJobOptions(session.id, session.snapshot.statusChangedAt));
    return session.toDto();
  }

  /** La persona puede borrar su foto en cualquier momento, sin esperar al TTL. */
  async deletePhoto(id: string, requester: Requester) {
    const session = await this.owned(id, requester);
    const keys = session.purgePhoto();
    await this.storage.deleteMany(keys);
    await this.sessions.save(session);
    return session.toDto();
  }

  /** Guardar el resultado en la cuenta: único caso en que sobrevive al TTL. */
  async saveResult(id: string, requester: Requester) {
    if (!requester.userId) throw new BadRequestException('necesitas una cuenta para guardar');
    const session = await this.owned(id, requester);
    const currentKey = session.resultKey;
    if (!currentKey) throw new ConflictException('no hay resultado');
    const image = await this.storage.getBuffer(currentKey);
    if (!image) throw new ConflictException('el resultado ya expiró');
    this.domain(() => session.saveResult(requester.userId!));
    if (session.resultKey !== currentKey) {
      await this.storage.put(session.resultKey!, image, 'image/png');
      await this.storage.deleteMany([currentKey]);
    }
    await this.sessions.save(session);
    return session.toDto();
  }

  async privateImage(id: string, kind: 'photo' | 'result', requester: Requester) {
    const session = await this.owned(id, requester);
    const key = kind === 'photo' ? session.photoKey : session.resultKey;
    const obj = key ? await this.storage.get(key) : null;
    if (!obj) throw new NotFoundException();
    return obj;
  }

  private async owned(id: string, requester: Requester) {
    const session = await this.sessions.findOwned(id, requester);
    if (!session) throw new NotFoundException('sesión no encontrada');
    return session;
  }

  private domain<T>(fn: () => T): T {
    try {
      return fn();
    } catch (err) {
      if (err instanceof DomainError) throw new ConflictException(err.message);
      throw err;
    }
  }
}
