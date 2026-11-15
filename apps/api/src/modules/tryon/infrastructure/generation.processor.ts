import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { AI_DRESSING_ORDER, AI_WEARABLE } from '@vestirse/shared-types';
import { ObjectStorage } from '../../../common/storage';
import { AiSettingsService } from '../../ai-settings/ai-settings.module';
import { CatalogRepository } from '../../catalog/application/catalog.repository';
import { MetricsService } from '../../metrics/metrics.module';
import { describeBody, describeFit } from '../application/fit-brief';
import { GarmentTransferPort, TransferUnavailableError, type TransferGarment, type TransferResult } from '../application/garment-transfer.port';
import { TryOnSessionRepository } from '../application/tryon-session.repository';
import { GENERATION_QUEUE, type GenerationJob } from '../application/tryon.service';
import type { TryOnSession } from '../domain/tryon-session.entity';
import { TryOnGateway } from './tryon.gateway';

/**
 * Caso de uso GenerateTryOn, ejecutado fuera del ciclo de la petición (Track B es lento).
 *
 * Política de fallos:
 * - Proveedor no disponible de forma transitoria (timeout, 5xx, 429) → se relanza y
 *   BullMQ reintenta con backoff; en el último intento se ofrece el fallback.
 * - Proveedor no disponible de forma definitiva (sin configurar, categoría no
 *   soportada, circuito abierto) → fallback inmediato (modelo similar / overlay).
 * - Fallo propio (sin foto, falta la prenda, error inesperado agotado) → `failed`.
 *
 * Los motores gratuitos tienen cuota diaria: si la misma persona ya probó esta prenda
 * con esta misma foto, se reutiliza ese resultado en vez de volver a generar.
 *
 * Conjuntos (probador): los motores visten una prenda por llamada, así que se aplican de
 * dentro hacia fuera (pantalón, camisa, chaqueta) y cada resultado es la persona del paso
 * siguiente. Calzado y accesorios no los sabe poner la IA: se quedan en la vista instantánea.
 */
@Processor(GENERATION_QUEUE, { concurrency: 2 })
export class GenerationProcessor extends WorkerHost {
  private readonly logger = new Logger(GenerationProcessor.name);

  constructor(
    private readonly sessions: TryOnSessionRepository,
    private readonly catalog: CatalogRepository,
    private readonly storage: ObjectStorage,
    private readonly transfer: GarmentTransferPort,
    private readonly aiSettings: AiSettingsService,
    private readonly gateway: TryOnGateway,
    private readonly metrics: MetricsService,
  ) {
    super();
  }

  async process(job: Job<GenerationJob>): Promise<void> {
    const session = await this.sessions.findById(job.data.sessionId);
    // Borrada, o ya resuelta (p. ej. el reaper la marcó como atascada): el trabajo es obsoleto.
    if (!session || !session.isInFlight) return;
    if (!session.photoKey) return this.end(session, 'failed', 'no-photo');

    const sessionId = session.id;
    const attempt = job.attemptsMade + 1;
    const isLastAttempt = attempt >= (job.opts.attempts ?? 1);

    // Cada intento refresca statusChangedAt: el reaper solo ve atascado lo que de verdad no avanza.
    session.markProcessing();
    await this.sessions.save(session);
    this.gateway.emit({ sessionId, status: 'processing', progress: 0.1 });

    try {
      const [person, garments] = await Promise.all([this.storage.getBuffer(session.photoKey), this.garmentsFor(session)]);
      if (!person || !garments) return this.end(session, 'failed', 'missing-input');
      if (garments.length === 0) return this.end(session, 'fallback', 'unsupported');

      // Con resultado propio, pedir otra generación es querer una imagen nueva: no se reutiliza.
      const reused = session.resultKey || garments.length > 1 ? null : await this.previousResult(session, person);
      let result: TransferResult = { image: reused ?? person, engine: 'reused', durationMs: 0 };
      if (!reused) {
        const credentials = await this.aiSettings.resolve();
        for (const [step, garment] of garments.entries()) {
          if (step > 0) {
            // Paso intermedio: refrescar el estado para que el reaper no lo tome por atascado.
            session.markProcessing();
            await this.sessions.save(session);
            this.gateway.emit({ sessionId, status: 'processing', progress: 0.1 + (0.8 * step) / garments.length });
          }
          const previous: TransferResult = result;
          result = await this.transfer.generate({
            requestId: garments.length > 1 ? `${sessionId}-${attempt}-${step}` : `${sessionId}-${attempt}`,
            person: previous.image,
            garments: [garment],
            bodyBrief: describeBody(),
            credentials,
          });
          result = { ...result, durationMs: previous.durationMs + result.durationMs };
        }
      }

      // Re-leer: la persona pudo borrar la foto mientras se generaba; en ese caso se descarta el resultado.
      const current = await this.sessions.findById(sessionId);
      if (!current || !current.photoKey || !current.isInFlight) return;
      current.complete();
      await this.storage.put(current.resultKey!, result.image, 'image/png');
      await this.sessions.save(current);
      await this.metrics.record('generation-completed', { sessionId, durationMs: result.durationMs, engine: result.engine });
      this.gateway.emit({ sessionId, status: 'done', progress: 1, resultImageUrl: current.toDto().resultImageUrl });
    } catch (err) {
      if (err instanceof TransferUnavailableError) {
        // La cuota de GPU es diaria: reintentar a los pocos segundos solo alarga la espera.
        if (err.retryable && err.reason !== 'rate-limited' && !isLastAttempt) {
          this.logger.warn(`generación ${sessionId}: ${err.reason}, intento ${attempt}; se reintentará`);
          throw err;
        }
        return this.end(session, 'fallback', err.reason);
      }
      if (!isLastAttempt) throw err;
      this.logger.error(`generación ${sessionId} falló: ${(err as Error).message}`);
      return this.end(session, 'failed', 'internal');
    }
  }

  /** Prendas que la IA puede vestir, en orden de dentro hacia fuera; null si falta alguna imagen. */
  private async garmentsFor(session: TryOnSession): Promise<TransferGarment[] | null> {
    const loaded = await Promise.all(
      session.garmentIds.map(async (id) => {
        const [garment, photo] = await Promise.all([this.catalog.findGarment(id), this.catalog.garmentPhoto(id)]);
        const image = photo ? await this.storage.getBuffer(photo.key) : null;
        return garment && photo && image ? { garment, photo, image } : null;
      }),
    );
    const found = loaded.filter((g) => g !== null);
    if (found.length < loaded.length) return null;
    const single = found.length === 1;
    return found
      .filter((g) => single || AI_WEARABLE.includes(g.garment.category))
      .sort((a, b) => AI_DRESSING_ORDER[a.garment.category] - AI_DRESSING_ORDER[b.garment.category])
      .map(({ garment, photo, image }) => ({
        image,
        mime: 'image/jpeg',
        category: garment.category,
        name: garment.name,
        color: garment.color,
        fit: describeFit(null, garment.category, garment.knownLimitations),
        photoType: photo.photoType,
      }));
  }

  private async previousResult(session: TryOnSession, person: Buffer): Promise<Buffer | null> {
    const { ownerSid, userId } = session.snapshot;
    const earlier = (await this.sessions.listOwned({ sid: ownerSid, userId }, 30)).filter(
      (s) => s.id !== session.id && s.garmentId === session.garmentId && s.status === 'done' && s.photoKey && s.resultKey,
    );
    for (const candidate of earlier) {
      const photo = await this.storage.getBuffer(candidate.photoKey!);
      if (!photo?.equals(person)) continue;
      const result = await this.storage.getBuffer(candidate.resultKey!);
      if (result) return result;
    }
    return null;
  }

  private async end(session: TryOnSession, status: 'failed' | 'fallback', reason: string) {
    const current = (await this.sessions.findById(session.id)) ?? session;
    if (status === 'fallback') current.fallback(reason);
    else current.fail(reason);
    await this.sessions.save(current);
    await this.metrics.record('generation-failed', { sessionId: current.id, reason, status });
    this.gateway.emit({ sessionId: current.id, status, progress: 1, fallbackReason: reason });
  }
}
