import type { GarmentItem } from '@vestirse/shared-types';

/**
 * Tallas de diferencia entre la elegida y la recomendada, según el orden de la tabla de la prenda.
 * 0 si falta alguna de las dos (sin recomendación no se exagera nada).
 */
export function sizeDelta(chart: Pick<GarmentItem['sizeChart'][number], 'size'>[], chosen?: string, recommended?: string): number {
  if (!chosen || !recommended) return 0;
  const i = chart.findIndex((s) => s.size === chosen);
  const j = chart.findIndex((s) => s.size === recommended);
  return i < 0 || j < 0 ? 0 : Math.max(-3, Math.min(3, i - j));
}

/** Talla recomendada de cada prenda para la persona de la sesión (perfil guardado); vacío si no hay perfil. */
export abstract class RecommendedSizes {
  abstract forUser(userId: string | undefined, garments: GarmentItem[]): Promise<Map<string, string>>;

  /** Medidas del perfil en una frase para la IA de imagen; vacío sin perfil. */
  async bodyFor(_userId: string | undefined): Promise<string> {
    return '';
  }
}

/** "172 cm tall, about 70 kg, chest 96 cm, waist 82 cm, hips 98 cm": solo lo que la persona guardó. */
export function bodyBrief(p: { heightCm: number; weightKg?: number | null; chestCm?: number | null; waistCm?: number | null; hipCm?: number | null }): string {
  const parts = [`${Math.round(p.heightCm)} cm tall`];
  if (p.weightKg) parts.push(`about ${Math.round(p.weightKg)} kg`);
  if (p.chestCm) parts.push(`chest ${Math.round(p.chestCm)} cm`);
  if (p.waistCm) parts.push(`waist ${Math.round(p.waistCm)} cm`);
  if (p.hipCm) parts.push(`hips ${Math.round(p.hipCm)} cm`);
  return parts.join(', ');
}
