import { describe, expect, it } from 'vitest';
import type { SizeChartEntry } from '@vestirse/shared-types';
import { BrandCalibration } from './brand-calibration';
import { FitEngine } from './fit-engine';
import { rangeScore } from './strategies';

const detailedTop: SizeChartEntry[] = [
  { size: 'S', chestCm: [84, 91], waistCm: [70, 77] },
  { size: 'M', chestCm: [92, 99], waistCm: [78, 85] },
  { size: 'L', chestCm: [100, 107], waistCm: [86, 93] },
  { size: 'XL', chestCm: [108, 115], waistCm: [94, 101] },
];

const genericLetters: SizeChartEntry[] = [{ size: 'S' }, { size: 'M' }, { size: 'L' }, { size: 'XL' }];
const numericNoData: SizeChartEntry[] = [{ size: '38' }, { size: '40' }, { size: '42' }];

const engine = new FitEngine();

describe('rangeScore', () => {
  it('da 1 dentro del rango y decae fuera', () => {
    expect(rangeScore(95, [92, 99])).toBe(1);
    expect(rangeScore(103, [92, 99])).toBeCloseTo(0.5);
    expect(rangeScore(120, [92, 99])).toBe(0);
  });
});

describe('FitEngine', () => {
  it('medidas estimadas por foto: misma talla, confianza media y lo dice', () => {
    const rec = engine.recommend({
      measurements: { heightCm: 175, chestCm: 96, waistCm: 80, estimatedFromPose: true },
      sizeChart: detailedTop,
      category: 'top',
    });
    expect(rec.recommendedSize).toBe('M');
    expect(rec.confidence).toBe('medium');
    expect(rec.basis).toContain('fit.basis.estimatedFromPhoto');
    expect(rec.basis).not.toContain('fit.basis.chestProvided');
  });

  it('medidas de IA contra las medidas reales de la prenda: no cuentan como cinta métrica', () => {
    const withGarment: SizeChartEntry[] = detailedTop.map((e, i) => ({ ...e, garment: { chestCm: 98 + i * 7, lengthCm: 68 + i * 2 } }));
    const rec = engine.recommend({
      measurements: { heightCm: 175, chestCm: 96, waistCm: 80, estimatedFromPose: true },
      sizeChart: withGarment,
      category: 'top',
    });
    expect(rec.basis).toContain('fit.basis.estimatedFromPhoto');
    expect(rec.basis).not.toContain('fit.basis.tapeMeasured');
    expect(rec.confidence).not.toBe('high');
  });

  it('confianza alta con medidas y tabla detallada', () => {
    const rec = engine.recommend({
      measurements: { heightCm: 175, chestCm: 96, waistCm: 80 },
      sizeChart: detailedTop,
      category: 'top',
    });
    expect(rec.recommendedSize).toBe('M');
    expect(rec.confidence).toBe('high');
    expect(rec.basis).toContain('fit.basis.chestProvided');
  });

  it('la medida más restrictiva domina', () => {
    const rec = engine.recommend({
      measurements: { heightCm: 175, chestCm: 96, waistCm: 90 },
      sizeChart: detailedTop,
      category: 'top',
    });
    expect(rec.recommendedSize).toBe('L');
  });

  it('confianza media con solo altura y tabla genérica', () => {
    const rec = engine.recommend({ measurements: { heightCm: 168 }, sizeChart: genericLetters, category: 'top' });
    expect(rec.confidence).toBe('medium');
    expect(rec.recommendedSize).toBe('M');
    expect(rec.basis).toContain('fit.basis.genericChart');
  });

  it('confianza baja con datos insuficientes, pero igual recomienda', () => {
    const rec = engine.recommend({ measurements: { heightCm: 170 }, sizeChart: numericNoData, category: 'bottom' });
    expect(rec.confidence).toBe('low');
    expect(rec.basis).toEqual(['fit.basis.insufficientData']);
    expect(numericNoData.map((e) => e.size)).toContain(rec.recommendedSize);
  });

  it('fuera de tabla → baja confianza y talla más cercana', () => {
    const rec = engine.recommend({
      measurements: { heightCm: 180, chestCm: 130 },
      sizeChart: detailedTop,
      category: 'top',
    });
    expect(rec.confidence).toBe('low');
    expect(rec.recommendedSize).toBe('XL');
    expect(rec.basis).toContain('fit.basis.outsideChart');
  });

  it('entre dos tallas: tela sin stretch → la mayor, con alternativa', () => {
    const rec = engine.recommend({
      measurements: { heightCm: 175, chestCm: 99.5 },
      sizeChart: detailedTop,
      category: 'top',
      stretch: 'none',
    });
    expect(rec.recommendedSize).toBe('L');
    expect(rec.alternativeSize).toBe('M');
    expect(rec.basis).toContain('fit.basis.betweenSizesLowStretch');
  });

  it('entre dos tallas: tela elástica → la menor', () => {
    const rec = engine.recommend({
      measurements: { heightCm: 175, chestCm: 99.5 },
      sizeChart: detailedTop,
      category: 'top',
      stretch: 'high',
    });
    expect(rec.recommendedSize).toBe('M');
    expect(rec.alternativeSize).toBe('L');
  });

  it('la pose sola nunca decide', () => {
    const rec = engine.recommend({
      measurements: { heightCm: 170 },
      sizeChart: numericNoData,
      category: 'top',
      poseRatios: { shoulderToHipRatio: 1.4 },
    });
    expect(rec.confidence).toBe('low');
  });

  it('la pose refuerza pero no reemplaza las medidas', () => {
    const rec = engine.recommend({
      measurements: { heightCm: 175, chestCm: 95, waistCm: 81 },
      sizeChart: detailedTop,
      category: 'top',
      poseRatios: { shoulderToHipRatio: 1.4 },
    });
    expect(rec.recommendedSize).toBe('M');
    expect(rec.basis).toContain('fit.basis.poseReinforced');
  });

  it('exige altura', () => {
    expect(() => engine.recommend({ measurements: { heightCm: 0 }, sizeChart: detailedTop, category: 'top' })).toThrow();
  });

  describe('calibración por marca', () => {
    const runsSmall = Array.from({ length: 25 }).reduce<BrandCalibration>(
      (cal) => cal.record(1, 2),
      BrandCalibration.empty('b1'),
    );

    it('no se aplica con pocas muestras', () => {
      const few = BrandCalibration.empty('b1').record(1, 2).record(1, 2);
      expect(few.offset).toBe(0);
    });

    it('sube una talla cuando la marca talla pequeño, y lo declara', () => {
      const rec = engine.recommend({
        measurements: { heightCm: 175, chestCm: 96, waistCm: 80 },
        sizeChart: detailedTop,
        category: 'top',
        calibration: runsSmall,
      });
      expect(rec.recommendedSize).toBe('L');
      expect(rec.basis).toContain('fit.basis.brandRunsSmall');
    });

    it('no se sale de la tabla', () => {
      const rec = engine.recommend({
        measurements: { heightCm: 190, chestCm: 112 },
        sizeChart: detailedTop,
        category: 'top',
        calibration: runsSmall,
      });
      expect(rec.recommendedSize).toBe('XL');
    });
  });
});
