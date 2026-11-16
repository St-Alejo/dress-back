import { bodyBrief, sizeDelta } from './outfit-finish';

const chart = [{ size: 'XS' }, { size: 'S' }, { size: 'M' }, { size: 'L' }, { size: 'XL' }];

describe('sizeDelta', () => {
  it('cuenta las tallas de diferencia en el orden de la tabla', () => {
    expect(sizeDelta(chart, 'L', 'M')).toBe(1);
    expect(sizeDelta(chart, 'S', 'M')).toBe(-1);
    expect(sizeDelta(chart, 'XL', 'S')).toBe(3);
    expect(sizeDelta(chart, 'M', 'M')).toBe(0);
  });

  it('sin recomendación o con una talla que no está en la tabla, no exagera nada', () => {
    expect(sizeDelta(chart, 'L', undefined)).toBe(0);
    expect(sizeDelta(chart, 'XXL', 'M')).toBe(0);
    expect(sizeDelta([], 'L', 'M')).toBe(0);
  });
});

describe('bodyBrief', () => {
  it('solo lleva las medidas que la persona guardó, redondeadas', () => {
    expect(bodyBrief({ heightCm: 171.6, weightKg: 70.2, chestCm: 96, waistCm: null, hipCm: 99.5 })).toBe('172 cm tall, about 70 kg, chest 96 cm, hips 100 cm');
    expect(bodyBrief({ heightCm: 160 })).toBe('160 cm tall');
  });
});
