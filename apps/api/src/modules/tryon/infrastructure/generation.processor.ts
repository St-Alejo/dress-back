import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { ObjectStorage } from '../../../common/storage';
import { AiSettingsService } from '../../ai-settings/ai-settings.module';
import { CatalogRepository } from '../../catalog/application/catalog.repository';
import { MetricsService } from '../../metrics/metrics.module';
import { describeBody, describeFit } from '../application/fit-brief';
import { GarmentTransferPort, TransferUnavailableError } from '../application/garment-transfer.port';
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
      const garment = await this.catalog.findGarment(session.garmentId);
      const photo = await this.catalog.garmentPhoto(session.garmentId);
      const [person, garmentImage] = await Promise.all([
        this.storage.getBuffer(session.photoKey),
        photo ? this.storage.getBuffer(photo.key) : null,
      ]);
      if (!garment || !photo || !person || !garmentImage) return this.end(session, 'failed', 'missing-input');

      // Con resultado propio, pedir otra generación es querer una imagen nueva: no se reutiliza.
      const reused = session.resultKey ? null : await this.previousResult(session, person);
      const result = reused ? { image: reused, engine: 'reused', durationMs: 0 } : await this.transfer.generate({
        requestId: `${sessionId}-${attempt}`,
        person,
        garments: [
          {
            image: garmentImage,
            mime: 'image/jpeg',
            category: garment.category,
            name: garment.name,
            color: garment.color,
            fit: describeFit(null, garment.category, garment.knownLimitations),
            photoType: photo.photoType,
          },
        ],
        bodyBrief: describeBody(),
        credentials: await this.aiSettings.resolve(),
      });

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
