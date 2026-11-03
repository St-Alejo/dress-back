import type { BodyProfile, FitAnalysis, GarmentCategory } from '@vestirse/shared-types';

/**
 * Traduce el análisis determinista a descriptores relativos y gruesos, al estilo
 * de FitVTON ("medium-size skirt on a tall, plus-size body"), en inglés para el
 * modelo. Solo estos textos viajan a la cola y al proveedor: nunca estatura ni peso.
 */
export interface GarmentBrief {
  garmentId: string;
  size: string;
  category: GarmentCategory;
  name: string;
  color: string;
  /** Descripción de ajuste para el modelo generativo. */
  fit: string;
}

const EASE: Record<string, string> = {
  tight: 'tight, fabric visibly stretched and pulling',
  fitted: 'snug, close to the body',
  regular: 'regular fit, as designed',
  loose: 'relaxed and slightly loose',
  oversized: 'very loose, clearly oversized and baggy',
};

const HEM: Record<string, string> = {
  waist: 'at the waist',
  hip: 'at the hips',
  'upper-thigh': 'at the upper thigh',
  'mid-thigh': 'at mid-thigh',
  knee: 'at the knee',
  'mid-calf': 'at mid-calf',
  ankle: 'at the ankle',
  floor: 'down to the floor',
};

const SLEEVE: Record<string, string> = {
  'upper-arm': 'sleeves end on the upper arm',
  elbow: 'sleeves end around the elbow',
  forearm: 'sleeves end on the forearm',
  wrist: 'sleeves end at the wrist',
  'over-hand': 'sleeves are too long and partly cover the hands',
};

/** Marca del catálogo para pantalones de corte ancho (palazzo): el motor local los genera aparte. */
export const WIDE_LEG = 'limitation.wideLeg';
const WIDE_CUT = 'wide-leg cut, loose and flowing from hip to hem';

export function describeFit(a: FitAnalysis | null, category: GarmentCategory, limitations: string[] = []): string {
  const fit = describeSize(a, category);
  return category === 'bottom' && limitations.includes(WIDE_LEG) ? `${fit}; ${WIDE_CUT}` : fit;
}

function describeSize(a: FitAnalysis | null, category: GarmentCategory): string {
  if (!a) return 'regular fit';
  const parts: string[] = [];
  for (const z of a.zones) parts.push(`${EASE[z.label]} at the ${z.zone}`);
  if (a.length) {
    if (category === 'bottom' && (a.length.label === 'long' || a.length.label === 'too-long')) {
      parts.push('trouser hems are too long and bunch at the ankles');
    } else {
      parts.push(`hem falls ${HEM[a.length.landmark]}${a.length.label === 'too-long' ? ', noticeably longer than intended' : a.length.label === 'too-short' ? ', noticeably shorter than intended' : ''}`);
    }
  }
  if (a.sleeve) parts.push(SLEEVE[a.sleeve.landmark]);
  const overall = { good: 'the size fits well', large: 'the size is a bit large', 'too-large': 'the size is too large for this person', 'too-small': 'the size is too small for this person' }[a.verdict];
  return `${overall}; ${parts.join('; ')}`;
}

/** Categorías gruesas de estatura y complexión. Sin números, sin juicios. */
export function describeBody(p?: BodyProfile): string {
  if (!p?.heightCm) return 'person as shown in the photo';
  const h = p.heightCm;
  const height = h < 158 ? 'short' : h < 166 ? 'medium-short' : h < 176 ? 'medium-tall' : 'tall';
  if (!p.weightKg) return `${height} person`;
  const bmi = p.weightKg / (h / 100) ** 2;
  const build = bmi < 20 ? 'slim' : bmi < 25 ? 'medium' : bmi < 30 ? 'medium plus-size' : 'plus-size';
  return `${height}, ${build} build`;
}
