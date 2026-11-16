import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WORKER_HEADERS } from '@vestirse/shared-types';
import { OutfitFinisherPort, type FinishRequest, type TransferResult } from '../application/garment-transfer.port';

/** La edición de imagen tarda ~30-60 s; con margen para la cola de OpenAI. */
const FINISH_TIMEOUT_MS = 180_000;

/** POST /v1/finish del worker. Cualquier fallo devuelve null: el acabado nunca rompe una prueba. */
@Injectable()
export class WorkerOutfitFinisher extends OutfitFinisherPort {
  private readonly logger = new Logger(WorkerOutfitFinisher.name);
  private readonly baseUrl: string;
  private readonly token?: string;
  override readonly dressesOutfits: boolean;

  constructor(config: ConfigService) {
    super();
    this.baseUrl = config.getOrThrow<string>('AI_WORKER_URL');
    this.token = config.get<string>('WORKER_TOKEN') || undefined;
    this.dressesOutfits = config.get<string>('AI_DRESS_ENGINE') === 'openai';
  }

  async finish(req: FinishRequest): Promise<TransferResult | null> {
    const form = new FormData();
    form.append('person_image', new Blob([new Uint8Array(req.person)], { type: 'image/png' }), 'person.png');
    req.pieces.forEach((p, i) => form.append('item_images', new Blob([new Uint8Array(p.image)], { type: p.mime }), `item-${i}.jpg`));
    form.append(
      'manifest',
      JSON.stringify({
        mode: req.mode ?? 'retouch',
        body: req.body ?? '',
        pieces: req.pieces.map(({ category, name, delta, openFront }, index) => ({ index, category, name, delta, openFront: !!openFront })),
      }),
    );
    const headers: Record<string, string> = { [WORKER_HEADERS.requestId]: req.requestId };
    if (this.token) headers[WORKER_HEADERS.token] = this.token;
    try {
      const res = await fetch(`${this.baseUrl}/v1/finish`, { method: 'POST', body: form, headers, signal: AbortSignal.timeout(FINISH_TIMEOUT_MS) });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { code?: string } | null;
        this.logger.warn(`acabado ${req.requestId} no disponible: ${body?.code ?? res.status}`);
        return null;
      }
      return {
        image: Buffer.from(await res.arrayBuffer()),
        engine: res.headers.get(WORKER_HEADERS.engine) ?? 'finish',
        durationMs: Number(res.headers.get(WORKER_HEADERS.durationMs) ?? 0),
      };
    } catch (err) {
      this.logger.warn(`acabado ${req.requestId} falló: ${(err as Error).message}`);
      return null;
    }
  }
}
