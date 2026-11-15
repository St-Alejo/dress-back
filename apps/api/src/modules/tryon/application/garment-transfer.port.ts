import type { GarmentCategory, GarmentPhotoType, WorkerErrorCode } from '@vestirse/shared-types';
import type { AiCredentials } from '../../ai-settings/ai-settings.module';

export interface TransferResult {
  image: Buffer;
  engine: string;
  durationMs: number;
}

/** Códigos del contrato del worker más el estado del circuit breaker local. */
export type TransferFailure = WorkerErrorCode | 'circuit-open';

export class TransferUnavailableError extends Error {
  constructor(
    readonly reason: TransferFailure,
    /** true = vale la pena reintentar (BullMQ lo hará con backoff). */
    readonly retryable: boolean,
  ) {
    super(reason);
  }
}

export interface TransferGarment {
  image: Buffer;
  mime: string;
  category: GarmentCategory;
  name: string;
  color: string;
  /** Descriptor de ajuste derivado del análisis por talla (ver fit-brief.ts). */
  fit: string;
  /** Si la foto muestra la prenda sola o puesta en una persona. */
  photoType?: GarmentPhotoType;
}

export interface TransferRequest {
  /** Correlación de extremo a extremo (logs de la API y del worker). */
  requestId: string;
  person: Buffer;
  /** Conjunto completo: una o varias prendas. */
  garments: TransferGarment[];
  /** Estatura y complexión en categorías gruesas, sin números. */
  bodyBrief: string;
  credentials: AiCredentials;
}

/** Puerto hacia el proveedor de inferencia (Adapter, sección 10). */
export abstract class GarmentTransferPort {
  abstract generate(req: TransferRequest): Promise<TransferResult>;
}

/** Prenda para el acabado: foto de catálogo y tallas de diferencia con la recomendada (+1 = una mayor). */
export interface FinishPiece {
  image: Buffer;
  mime: string;
  category: GarmentCategory;
  name: string;
  delta: number;
}

export interface FinishRequest {
  requestId: string;
  /** Resultado del probador (la persona ya vestida). */
  person: Buffer;
  pieces: FinishPiece[];
}

/**
 * Acabado con IA de imagen (opcional y de pago, con tope en el worker): tela realista, talla elegida y
 * zapatos. Devuelve null si no está disponible; la prueba se queda con el resultado del probador.
 */
export abstract class OutfitFinisherPort {
  abstract finish(req: FinishRequest): Promise<TransferResult | null>;
}
