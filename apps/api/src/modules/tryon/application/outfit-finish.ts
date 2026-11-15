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
}
