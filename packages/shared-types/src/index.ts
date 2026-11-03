/**
 * Modelo de datos canónico (docs/README-virtual-tryon.md, sección 9).
 * Fuente única de verdad compartida por web y api.
 *
 * Varias decisiones de este archivo son invariantes éticas (sección 4) y están
 * cubiertas por tests en `invariants.spec.ts`: no cambiar la opcionalidad de
 * campos sin leer esa sección.
 */

export type GarmentCategory = 'top' | 'bottom' | 'dress' | 'outerwear' | 'footwear' | 'accessory';
export type TryOnMode = 'similar-model' | 'live-overlay' | 'photorealistic';
export type FitConfidence = 'low' | 'medium' | 'high';
export type Locale = 'es' | 'en';

/** Orden canónico de tallas alfabéticas; el catálogo de cuerpos debe cubrirlas todas (regla 4). */
export const LETTER_SIZES = ['XS', 'S', 'M', 'L', 'XL', 'XXL', '3XL', '4XL'] as const;
export type LetterSize = (typeof LETTER_SIZES)[number];

export interface BodyMeasurements {
  /** El único dato siempre pedido. */
  heightCm: number;
  chestCm?: number;
  waistCm?: number;
  hipCm?: number;
  /** true si se infirió de keypoints, no ingresado a mano. */
  estimatedFromPose?: boolean;
}

/** Proporciones derivadas de keypoints de pose (números, nunca imagen). */
export interface PoseRatios {
  /** Relación hombros/caderas normalizada: 1 ≈ proporción típica. */
  shoulderToHipRatio: number;
  torsoToHeightRatio?: number;
}

export interface SimilarBodyModel {
  id: string;
  heightRangeCm: [number, number];
  /** Etiqueta descriptiva, nunca clasificación reductiva. */
  bodyTypeTag: string;
  /** Talla alfabética de referencia que suele usar este cuerpo. */
  typicalSize: LetterSize;
  skinTone: string;
  /** Foto real de una persona con esta complexión. */
  photoUrl: string;
  /** garmentId -> prueba real generada por IA: el modelo con esa prenda puesta. Puede faltar. */
  previewImages: Record<string, string>;
  /** Pose y segmentación medidas una vez sobre la foto: permiten la "vista aproximada" al instante. */
  pose?: BodyPose;
  /** En la foto lleva una prenda de una pieza (vestido): ver `aiCanDress`. */
  onePiece?: boolean;
  /** En la foto tiene las manos en los bolsillos: ver `aiCanDress`. */
  handsInPockets?: boolean;
}

/**
 * Si la IA puede vestir la prenda sobre la foto de este modelo. Sobre un vestido, el motor solo
 * cambia la mitad de arriba o la de abajo y el resto del vestido sigue ahí (sale una túnica).
 * Con las manos en los bolsillos tapa la cintura: una falda o un palazzo salen convertidos en el
 * pantalón que ya llevaba.
 */
export function aiCanDress(body: Pick<SimilarBodyModel, 'onePiece' | 'handsInPockets'>, category: GarmentCategory): boolean {
  if (body.handsInPockets && category === 'bottom') return false;
  return !(body.onePiece && (category === 'top' || category === 'bottom'));
}

/**
 * Landmarks de MediaPipe (BlazePose, 33 puntos, normalizados 0–1) y segmentación selfie_multiclass
 * de la foto de un modelo, codificada por tramos [etiqueta, longitud, …] fila a fila.
 */
export interface BodyPose {
  version: 1;
  width: number;
  height: number;
  landmarks: { x: number; y: number; v: number }[];
  seg: { width: number; height: number; rle: number[] };
}

export type Silhouette = 'feminine' | 'masculine' | 'neutral';

/**
 * Perfil corporal para "medirse las prendas por talla". La estatura sigue siendo
 * lo único obligatorio; el peso permite estimar contornos. El peso NUNCA se
 * persiste en el servidor ni se registra en logs.
 */
export interface BodyProfile extends BodyMeasurements {
  weightKg?: number;
  /** Solo orienta la estimación de contornos; "neutral" promedia. */
  silhouette?: Silhouette;
}

/**
 * Cuerpo estimado a partir del perfil (cm). Con solo estatura no se inventan
 * contornos (quedan indefinidos): solo se pueden evaluar largos.
 */
export interface EstimatedBody {
  heightCm: number;
  chestCm?: number;
  waistCm?: number;
  hipCm?: number;
  /** true = inferido de estatura/peso; false = medido con cinta. */
  estimated: boolean;
}

/** Medidas de la PRENDA (no del cuerpo) para una talla: contornos y largos en cm. */
export interface GarmentDims {
  chestCm?: number;
  waistCm?: number;
  hipCm?: number;
  /** Largo desde el hombro (superiores/vestidos/abrigos) o desde la cintura (faldas). */
  lengthCm?: number;
  /** Largo de manga desde el hombro. */
  sleeveCm?: number;
  /** Entrepierna (pantalones y shorts). */
  inseamCm?: number;
}

/** Holgura con la que la prenda está diseñada (cm sobre el contorno del cuerpo). */
export interface FitIntent {
  chestEaseCm?: number;
  waistEaseCm?: number;
  hipEaseCm?: number;
}

export interface SizeChartEntry {
  size: string;
  chestCm?: [number, number];
  waistCm?: [number, number];
  hipCm?: [number, number];
  heightCm?: [number, number];
  /** Dimensiones reales de la prenda en esta talla. */
  garment?: GarmentDims;
}

export type EaseLabel = 'tight' | 'fitted' | 'regular' | 'loose' | 'oversized';
export type LengthLabel = 'too-short' | 'short' | 'as-designed' | 'long' | 'too-long';
export type HemLandmark = 'waist' | 'hip' | 'upper-thigh' | 'mid-thigh' | 'knee' | 'mid-calf' | 'ankle' | 'floor';
export type SleeveLandmark = 'upper-arm' | 'elbow' | 'forearm' | 'wrist' | 'over-hand';
export type FitVerdict = 'too-small' | 'good' | 'large' | 'too-large';

/** Análisis determinista de cómo le queda UNA talla a UN cuerpo. Fuente de verdad de la talla. */
export interface FitAnalysis {
  size: string;
  verdict: FitVerdict;
  zones: { zone: 'chest' | 'waist' | 'hip'; easeCm: number; label: EaseLabel }[];
  length?: { label: LengthLabel; landmark: HemLandmark };
  sleeve?: { label: LengthLabel; landmark: SleeveLandmark };
  /** Claves i18n con notas legibles. */
  notes: string[];
  bodyEstimated: boolean;
}

/** Una prenda del conjunto con la talla elegida. */
export interface OutfitItem {
  garmentId: string;
  size: string;
}

/**
 * Motores de prueba virtual. `hf-*` son Spaces gratuitos de Hugging Face (`hf-chain` los
 * prueba en orden); `fal-catvton` y `replicate` son APIs de pago; `mock` no usa IA.
 */
export type AiProvider = 'mock' | 'hf-chain' | 'hf-fashn' | 'hf-leffa' | 'hf-idm' | 'fal-catvton' | 'replicate';
export const AI_PROVIDERS: readonly AiProvider[] = ['mock', 'hf-chain', 'hf-fashn', 'hf-leffa', 'hf-idm', 'fal-catvton', 'replicate'];

/** Configuración de IA visible para el admin. La clave nunca viaja completa al cliente. */
export interface AiProviderSettings {
  provider: AiProvider;
  model?: string;
  keyConfigured: boolean;
  keyHint?: string;
  lastTestOk?: boolean | null;
  updatedAt?: string;
  source: 'database' | 'environment' | 'none';
}

export interface Brand {
  id: string;
  name: string;
}

/** "left" = lado izquierdo de la persona (derecha de la imagen sin espejo), igual que MediaPipe. */
export interface OverlayAnchors {
  leftShoulder: [number, number];
  rightShoulder: [number, number];
  leftHip: [number, number];
  rightHip: [number, number];
}

/** Puntos que se miden en el recorte de cada prenda (ver services/ai-worker/src/garment_prep/anchors.py). */
export type GarmentAnchorName =
  | 'neck' | 'leftShoulder' | 'rightShoulder' | 'leftArmpit' | 'rightArmpit' | 'leftCuff' | 'rightCuff'
  | 'leftHem' | 'rightHem' | 'leftWaist' | 'rightWaist' | 'crotch' | 'leftKnee' | 'rightKnee'
  | 'leftAnkle' | 'rightAnkle' | 'topLeft' | 'bottomRight' | 'base' | 'top'
  // Calzado (un solo zapato de perfil): extremos de la suela.
  | 'heel' | 'toe';

/**
 * Anclas medidas en la foto de la prenda, normalizadas a [0, 1] del recorte. Con ellas la
 * cámara deforma el recorte con una malla de huesos (mangas que siguen al brazo, perneras
 * que siguen a la rodilla). "left" = lado izquierdo de quien la viste, como en MediaPipe.
 */
export interface GarmentAnchors {
  version: 1;
  kind: 'upper' | 'lower' | 'skirt' | 'footwear' | 'accessory';
  /** ancho / alto del recorte. */
  aspect: number;
  points: Partial<Record<GarmentAnchorName, [number, number]>>;
  /** "hanging": las mangas cuelgan pegadas al cuerpo en la foto; la prenda se viste rígida con el torso. */
  sleeve?: 'none' | 'short' | 'long' | 'hanging';
}

/**
 * Cómo está fotografiada una prenda: sola (flat-lay), puesta en una persona (model) o
 * extraída de una foto con persona por el segmentador de ropa (extracted: ya es la prenda sola).
 */
export type GarmentPhotoType = 'flat-lay' | 'model' | 'extracted';

export interface GarmentItem {
  id: string;
  name: string;
  brandId: string;
  brandName?: string;
  category: GarmentCategory;
  color: string;
  priceCents: number;
  /** `photo` = foto real de producto; `cutout` = su recorte con transparencia (cámara en vivo). */
  images: { photo: string; cutout?: string; thumb?: string };
  photoType: GarmentPhotoType;
  /** Anclas medidas en el recorte; sin ellas no hay cámara en vivo ni vista aproximada. */
  anchors?: GarmentAnchors;
  style?: string;
  fitIntent?: FitIntent;
  sizeChart: SizeChartEntry[];
  /** "cae holgado", "tela con poco stretch" — contexto no visual. */
  fabricNotes?: string;
  stretch: 'none' | 'low' | 'medium' | 'high';
  knownLimitations?: string[];
}

export interface FitRecommendation {
  recommendedSize: string;
  confidence: FitConfidence;
  /** La persona siempre puede corregir la talla (sección 3, paso 6). */
  userOverride?: string;
  /** Claves i18n que explican el porqué, ej. ["fit.basis.heightProvided"]. */
  basis: string[];
  /** Talla alternativa cuando la persona está entre dos tallas. */
  alternativeSize?: string;
}

export type GenerationStatus = 'idle' | 'queued' | 'processing' | 'done' | 'failed' | 'fallback';

export type PhotoCheckReason = 'no-person' | 'multiple-people' | 'not-full-body' | 'not-frontal' | 'too-dark';

/**
 * Revisión automática del encuadre de la foto. Es un aviso, nunca un rechazo: la
 * persona decide si usa otra foto. `checked: false` = no se pudo analizar.
 */
export interface PhotoCheck {
  checked: boolean;
  ok: boolean;
  reason?: PhotoCheckReason | null;
}

/** Sugerencias de etiquetado de una prenda a partir de su foto (panel de admin). */
export interface GarmentSuggestion {
  style?: string;
  category?: GarmentCategory;
  photoType?: GarmentPhotoType;
  color?: string;
  name?: string;
}

export interface TryOnSession {
  id: string;
  /** Sesiones sin cuenta son válidas — no forzar login. */
  userId?: string;
  garmentId: string;
  mode: TryOnMode;
  bodyModelId?: string;
  /** Solo si mode === 'photorealistic'; NUNCA obligatorio (regla 1). */
  uploadedPhotoUrl?: string;
  /** TTL corto por defecto (sección 8). */
  photoExpiresAt?: string;
  resultImageUrl?: string;
  /** true solo si la persona guardó el resultado en su cuenta (sobrevive al TTL). */
  resultSaved?: boolean;
  generationStatus?: GenerationStatus;
  /** Motivo cuando `generationStatus` es `failed` o `fallback` (p. ej. "timeout", "stuck"). */
  failureReason?: string;
  fitRecommendation?: FitRecommendation;
  /** Conjunto a probar sobre la foto (varias prendas con su talla). */
  outfit?: OutfitItem[];
  createdAt: string;
  /** Solo en la respuesta de subir la foto, y solo si se pudo revisar. */
  photoCheck?: PhotoCheck;
}

export type FitFeeling = 'runs-small' | 'true-to-size' | 'runs-large';
export type FitZone = 'shoulders' | 'chest' | 'waist' | 'hips' | 'length' | 'sleeves';

export interface FitReview {
  id: string;
  garmentId: string;
  sizeBought: string;
  feeling: FitFeeling;
  zones: FitZone[];
  comment?: string;
  createdAt: string;
}

export interface FitReviewSummary {
  garmentId: string;
  total: number;
  runsSmall: number;
  trueToSize: number;
  runsLarge: number;
  topZones: FitZone[];
}

/** Progreso de Track B emitido por WebSocket. */
export interface GenerationProgressEvent {
  sessionId: string;
  status: GenerationStatus;
  progress: number;
  resultImageUrl?: string;
  fallbackReason?: string;
}

export type MetricEventType =
  | 'mode-used'
  | 'size-recommended'
  | 'size-overridden'
  | 'generation-completed'
  | 'generation-failed'
  | 'return-simulated';

/**
 * Métricas permitidas (sección 14). No existe (ni debe existir) un tipo de evento
 * de "tiempo mirando el propio cuerpo".
 */
export interface MetricEvent {
  type: MetricEventType;
  payload: Record<string, string | number | boolean>;
}

export interface MetricsSummary {
  modeDistribution: Record<TryOnMode, number>;
  recommendations: number;
  overrides: number;
  overrideRate: number;
  avgGenerationMs: number | null;
  avgPerceivedMs: number | null;
  generationFailures: number;
}

export interface AuthUser {
  id: string;
  email: string;
  role: 'user' | 'admin';
  retrainingConsent: boolean;
}

/**
 * Patrones de rutas prohibidas por la sección 4 (reglas 2 y 3): edición de silueta
 * y comparación entre usuarios. Usado por el test de invariantes de la API.
 */
export const FORBIDDEN_ROUTE_PATTERN =
  /silhouette|slim|reshape|body-?edit|leaderboard|compare-?users|body-?rank/i;

/** Retención por defecto de fotos subidas (sección 8, punto 2). */
export const PHOTO_TTL_HOURS = 24;

export * from './worker-contract';
