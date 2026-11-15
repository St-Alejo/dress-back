import type { FitRecommendation, GenerationStatus, OutfitItem, TryOnMode, TryOnSession as TryOnSessionDto } from '@vestirse/shared-types';
import type { Requester } from '../../../common/requester';

export interface TryOnSessionProps {
  id: string;
  ownerSid: string;
  userId?: string;
  garmentId: string;
  mode: TryOnMode;
  bodyModelId?: string;
  photoKey?: string;
  photoExpiresAt?: Date;
  resultKey?: string;
  resultSaved: boolean;
  generationStatus: GenerationStatus;
  fitRecommendation?: FitRecommendation;
  /** Conjunto a probar a la vez (incluye `garmentId`); sin él, solo esa prenda. */
  outfit?: OutfitItem[];
  /** Por qué terminó en `failed` o `fallback` (código del contrato o motivo interno). */
  failureReason?: string;
  /** Última transición de estado: permite detectar generaciones atascadas. */
  statusChangedAt: Date;
  createdAt: Date;
}

export class DomainError extends Error {}

const IN_FLIGHT: GenerationStatus[] = ['queued', 'processing'];

/**
 * Entidad raíz de una prueba. Encapsula las reglas de la sección 8:
 * la foto es opcional, expira, y solo se conserva el resultado si la persona
 * lo guarda explícitamente en su cuenta.
 */
export class TryOnSession {
  private constructor(private props: TryOnSessionProps) {}

  static start(args: {
    id: string;
    garmentId: string;
    mode: TryOnMode;
    bodyModelId?: string;
    outfit?: OutfitItem[];
    requester: Requester;
    now: Date;
  }) {
    if (args.outfit?.length && !args.outfit.some((o) => o.garmentId === args.garmentId)) {
      throw new DomainError('la prenda principal debe estar en el conjunto');
    }
    return new TryOnSession({
      id: args.id,
      ownerSid: args.requester.sid,
      userId: args.requester.userId,
      garmentId: args.garmentId,
      mode: args.mode,
      bodyModelId: args.bodyModelId,
      outfit: args.outfit?.length ? args.outfit : undefined,
      resultSaved: false,
      generationStatus: 'idle',
      statusChangedAt: args.now,
      createdAt: args.now,
    });
  }

  static restore(props: TryOnSessionProps) {
    return new TryOnSession({ ...props });
  }

  get id() { return this.props.id; }
  get garmentId() { return this.props.garmentId; }
  /** Prendas a probar: el conjunto o, si no hay, la prenda de la sesión. */
  get garmentIds() { return this.props.outfit?.map((o) => o.garmentId) ?? [this.props.garmentId]; }
  get mode() { return this.props.mode; }
  get photoKey() { return this.props.photoKey; }
  get resultKey() { return this.props.resultKey; }
  get status() { return this.props.generationStatus; }
  get fitRecommendation() { return this.props.fitRecommendation; }
  get failureReason() { return this.props.failureReason; }
  get isInFlight() { return IN_FLIGHT.includes(this.props.generationStatus); }
  get snapshot(): Readonly<TryOnSessionProps> { return { ...this.props }; }

  static photoKeyFor(id: string) { return `uploads/sessions/${id}/photo.jpg`; }
  static resultKeyFor(id: string) { return `uploads/sessions/${id}/result.png`; }
  static savedKeyFor(userId: string, id: string) { return `saved/${userId}/${id}.png`; }

  isOwnedBy(r: Requester): boolean {
    return this.props.ownerSid === r.sid || (!!r.userId && this.props.userId === r.userId);
  }

  changeMode(mode: TryOnMode) {
    this.props.mode = mode;
  }

  /** Comprobar antes de borrar la foto anterior: la generación en curso la está leyendo. */
  assertPhotoChangeable() {
    if (this.isInFlight) throw new DomainError('no se puede cambiar la foto mientras se genera');
  }

  /** Adjuntar foto implica modo fotorrealista y fija la expiración (TTL corto por defecto). */
  attachPhoto(now: Date, ttlHours: number) {
    this.assertPhotoChangeable();
    this.props.mode = 'photorealistic';
    this.props.photoKey = TryOnSession.photoKeyFor(this.id);
    this.props.photoExpiresAt = new Date(now.getTime() + ttlHours * 3600_000);
    this.transition('idle', now);
  }

  /** También se permite desde `failed` o `fallback`: reintentar es decisión de la persona. */
  requestGeneration(now = new Date()) {
    if (!this.props.photoKey) throw new DomainError('primero hay que subir una foto');
    if (this.isInFlight) throw new DomainError('ya hay una generación en curso');
    this.transition('queued', now);
  }

  markProcessing(now = new Date()) {
    if (!this.isInFlight) throw new DomainError('la generación no está en curso');
    this.transition('processing', now);
  }

  complete(now = new Date()) {
    this.props.resultKey = TryOnSession.resultKeyFor(this.id);
    // El resultado nuevo es temporal aunque uno anterior se guardara (ese sigue en saved/).
    this.props.resultSaved = false;
    this.transition('done', now);
  }

  /** El proveedor no está disponible: se ofrece el modelo similar / overlay en vez de un error. */
  fallback(reason: string, now = new Date()) {
    this.transition('fallback', now, reason);
  }

  /** Fallo definitivo (sin foto, atascada, reintentos agotados). La persona puede volver a intentar. */
  fail(reason: string, now = new Date()) {
    this.transition('failed', now, reason);
  }

  /** Una generación en curso que no cambia de estado en `maxMs` se considera atascada. */
  isStuck(now: Date, maxMs: number): boolean {
    return this.isInFlight && now.getTime() - this.props.statusChangedAt.getTime() > maxMs;
  }

  private transition(status: GenerationStatus, now: Date, reason?: string) {
    this.props.generationStatus = status;
    this.props.statusChangedAt = now;
    this.props.failureReason = reason;
  }

  saveResult(userId: string) {
    if (!this.props.resultKey) throw new DomainError('no hay resultado para guardar');
    if (this.props.userId && this.props.userId !== userId) throw new DomainError('sesión de otra cuenta');
    this.props.userId = userId;
    this.props.resultSaved = true;
    this.props.resultKey = TryOnSession.savedKeyFor(userId, this.id);
  }

  setFitRecommendation(rec: FitRecommendation) {
    this.props.fitRecommendation = rec;
  }

  isExpired(now: Date): boolean {
    return !!this.props.photoExpiresAt && this.props.photoExpiresAt <= now;
  }

  /**
   * Retira la foto (y el resultado no guardado). Devuelve las claves a borrar del
   * almacenamiento: el borrado es real, no un flag (sección 8.5).
   */
  purgePhoto(): string[] {
    const keys: string[] = [];
    if (this.props.photoKey) keys.push(this.props.photoKey);
    if (this.props.resultKey && !this.props.resultSaved) {
      keys.push(this.props.resultKey);
      this.props.resultKey = undefined;
      if (this.props.generationStatus === 'done') this.transition('idle', new Date());
    }
    this.props.photoKey = undefined;
    this.props.photoExpiresAt = undefined;
    return keys;
  }

  toDto(): TryOnSessionDto {
    const p = this.props;
    return {
      id: p.id,
      userId: p.userId,
      garmentId: p.garmentId,
      mode: p.mode,
      bodyModelId: p.bodyModelId,
      uploadedPhotoUrl: p.photoKey ? `/api/tryon/sessions/${p.id}/photo` : undefined,
      photoExpiresAt: p.photoExpiresAt?.toISOString(),
      resultImageUrl: p.resultKey ? `/api/tryon/sessions/${p.id}/result` : undefined,
      resultSaved: p.resultSaved,
      generationStatus: p.generationStatus,
      failureReason: p.failureReason,
      fitRecommendation: p.fitRecommendation,
      outfit: p.outfit,
      createdAt: p.createdAt.toISOString(),
    };
  }
}
