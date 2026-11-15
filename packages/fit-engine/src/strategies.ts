import {
  LETTER_SIZES,
  type BodyMeasurements,
  type EstimatedBody,
  type FitIntent,
  type GarmentCategory,
  type GarmentItem,
  type PoseRatios,
} from '@vestirse/shared-types';
import { FitAnalyzer } from './fit-analysis';
import type { MeasureKey, SizeChart } from './size-chart';

export interface FitContext {
  chart: SizeChart;
  measurements: BodyMeasurements;
  category: GarmentCategory;
  poseRatios?: PoseRatios;
  /** Cuerpo con contornos medidos o estimados (estatura + peso). */
  body?: EstimatedBody;
  stretch?: GarmentItem['stretch'];
  fitIntent?: FitIntent;
}

export type EvidenceKind = 'measured' | 'estimated' | 'height' | 'pose';

export interface StrategyResult {
  /** Puntaje 0..1 por talla (1 = encaje perfecto). */
  scores: Record<string, number>;
  weight: number;
  evidence: EvidenceKind;
  basis: string[];
  /** true si alguna medida quedó fuera de todos los rangos de la tabla. */
  outsideChart?: boolean;
}

/** Patrón Strategy: cada método de estimación es intercambiable (sección 10). */
export interface FitStrategy {
  readonly name: string;
  evaluate(ctx: FitContext): StrategyResult | null;
}

/** Tolerancia en cm: a esta distancia fuera del rango el puntaje cae a 0. */
const TOLERANCE_CM = 8;

export function rangeScore(value: number, [min, max]: [number, number]): number {
  if (value >= min && value <= max) return 1;
  const distance = value < min ? min - value : value - max;
  return Math.max(0, 1 - distance / TOLERANCE_CM);
}

/** Medidas ingresadas a mano contra los rangos de la tabla. Evidencia más fuerte. */
export class ManualMeasurementsStrategy implements FitStrategy {
  readonly name = 'manual-measurements';
  private static readonly KEYS: { key: MeasureKey; basis: string }[] = [
    { key: 'chestCm', basis: 'fit.basis.chestProvided' },
    { key: 'waistCm', basis: 'fit.basis.waistProvided' },
    { key: 'hipCm', basis: 'fit.basis.hipProvided' },
  ];

  evaluate({ chart, measurements }: FitContext): StrategyResult | null {
    if (!chart.isDetailed()) return null;
    const usable = ManualMeasurementsStrategy.KEYS.filter(
      ({ key }) => measurements[key] !== undefined && chart.all.some((e) => e[key]),
    );
    if (usable.length === 0) return null;

    const scores: Record<string, number> = {};
    let outsideChart = false;
    for (const { key } of usable) {
      const value = measurements[key] as number;
      const fitsAny = chart.sizes.some((s) => {
        const r = chart.range(s, key);
        return r && value >= r[0] - 2 && value <= r[1] + 2;
      });
      if (!fitsAny) outsideChart = true;
    }
    for (const size of chart.sizes) {
      const perKey = usable
        .map(({ key }) => {
          const r = chart.range(size, key);
          return r ? rangeScore(measurements[key] as number, r) : undefined;
        })
        .filter((v): v is number => v !== undefined);
      // La medida más restrictiva domina: una prenda que no cierra en cintura no sirve aunque el pecho encaje.
      scores[size] = perKey.length ? Math.min(...perKey) : 0;
    }
    // Estimadas por la IA a partir de una foto: valen menos que la cinta métrica y así se dice.
    if (measurements.estimatedFromPose) {
      return { scores, weight: 2, evidence: 'estimated', basis: ['fit.basis.estimatedFromPhoto', 'fit.basis.detailedChart'], outsideChart };
    }
    return {
      scores,
      weight: 3,
      evidence: 'measured',
      basis: [...usable.map((u) => u.basis), 'fit.basis.detailedChart'],
      outsideChart,
    };
  }
}

/**
 * Altura → talla. Usa rangos de altura de la tabla si existen; si no, una tabla
 * genérica solo aplicable a tallas alfabéticas (evidencia débil).
 */
export class HeightOnlyStrategy implements FitStrategy {
  readonly name = 'height-only';
  /** Rangos genéricos por talla alfabética para prendas superiores/vestidos. */
  private static readonly GENERIC: Record<string, [number, number]> = {
    XS: [145, 158],
    S: [156, 165],
    M: [163, 173],
    L: [171, 180],
    XL: [178, 187],
    XXL: [184, 192],
    '3XL': [186, 196],
    '4XL': [188, 200],
  };

  evaluate({ chart, measurements }: FitContext): StrategyResult | null {
    const height = measurements.heightCm;
    if (!height) return null;
    if (chart.hasHeightRanges()) {
      return this.build(chart, (s) => chart.range(s, 'heightCm')!, height, 'fit.basis.chartHeight', 1.5);
    }
    const letterOnly = chart.sizes.every((s) => (LETTER_SIZES as readonly string[]).includes(s));
    if (!letterOnly) return null;
    return this.build(chart, (s) => HeightOnlyStrategy.GENERIC[s], height, 'fit.basis.genericChart', 1);
  }

  private build(
    chart: SizeChart,
    rangeOf: (size: string) => [number, number],
    height: number,
    basis: string,
    weight: number,
  ): StrategyResult {
    const scores: Record<string, number> = {};
    for (const size of chart.sizes) scores[size] = rangeScore(height, rangeOf(size));
    return { scores, weight, evidence: 'height', basis: ['fit.basis.heightProvided', basis] };
  }
}

/**
 * Compara el cuerpo (medido o estimado por estatura y peso) con las medidas REALES
 * de la prenda en cada talla. Es la evidencia más directa de "cómo me queda".
 */
export class GarmentMeasurementsStrategy implements FitStrategy {
  readonly name = 'garment-measurements';
  private readonly analyzer = new FitAnalyzer();
  private static readonly VERDICT_SCORE = { good: 1, large: 0.55, 'too-small': 0.1, 'too-large': 0.1 } as const;

  evaluate({ chart, category, body, measurements, stretch, fitIntent }: FitContext): StrategyResult | null {
    if (!body || body.chestCm === undefined) return null;
    const analyses = this.analyzer.analyzeAll({ body, category, sizeChart: [...chart.all], stretch, fitIntent });
    if (analyses.length === 0 || analyses.every((a) => a.zones.length === 0)) return null;
    const scores: Record<string, number> = {};
    for (const a of analyses) {
      // Dentro del mismo veredicto, gana la talla con más zonas "como fue diseñada".
      const asDesigned = a.zones.filter((z) => z.label === 'regular').length / Math.max(1, a.zones.length);
      const lengthOk = !a.length || a.length.label === 'as-designed' ? 0.05 : 0;
      scores[a.size] = Math.min(1, GarmentMeasurementsStrategy.VERDICT_SCORE[a.verdict] * 0.85 + asDesigned * 0.1 + lengthOk);
    }
    // Contornos estimados por IA a partir de una foto: valen como estimación, no como cinta.
    const fromPhoto = !!measurements.estimatedFromPose;
    const estimated = body.estimated || fromPhoto;
    const source = fromPhoto ? 'fit.basis.estimatedFromPhoto' : body.estimated ? 'fit.basis.estimatedFromWeight' : 'fit.basis.tapeMeasured';
    return {
      scores,
      weight: estimated ? 2.5 : 3.5,
      evidence: estimated ? 'estimated' : 'measured',
      basis: [source, 'fit.basis.garmentMeasurements'],
    };
  }
}

/**
 * Proporciones de pose (keypoints de Track A/B). Solo REFUERZA: nunca decide sola
 * y su peso es bajo, para no reemplazar el dato que la persona ingresó (sección 7.3).
 */
export class PoseRatioStrategy implements FitStrategy {
  readonly name = 'pose-ratio';

  evaluate({ chart, poseRatios, category }: FitContext): StrategyResult | null {
    if (!poseRatios || !['top', 'outerwear', 'dress'].includes(category)) return null;
    // Relación normalizada (1 ≈ típica). Hombros proporcionalmente anchos favorecen
    // levemente la talla siguiente en prendas superiores; estrechos, la anterior.
    const lean = poseRatios.shoulderToHipRatio > 1.12 ? 1 : poseRatios.shoulderToHipRatio < 0.9 ? -1 : 0;
    if (lean === 0) return null;
    const scores: Record<string, number> = {};
    chart.sizes.forEach((s, i) => (scores[s] = lean > 0 ? i / (chart.sizes.length - 1 || 1) : 1 - i / (chart.sizes.length - 1 || 1)));
    return { scores, weight: 0.3, evidence: 'pose', basis: ['fit.basis.poseReinforced'] };
  }
}
