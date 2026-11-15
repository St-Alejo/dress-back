import { describe, expect, it } from 'vitest';
import { AI_DRESSING_ORDER, outfitConflict, slotsOf } from './index';

describe('reglas del conjunto', () => {
  it('una prenda por zona: camisa + pantalón + chaqueta + zapatos es posible', () => {
    expect(outfitConflict(['top', 'bottom', 'outerwear', 'footwear', 'accessory'])).toBeNull();
  });

  it('no se pueden llevar dos camisas, ni vestido con pantalón', () => {
    expect(outfitConflict(['top', 'top'])).toBe('top');
    expect(outfitConflict(['dress', 'bottom'])).toBe('bottom');
    expect(slotsOf('dress')).toEqual(['top', 'bottom']);
  });

  it('la IA viste de dentro hacia fuera', () => {
    expect(AI_DRESSING_ORDER.bottom).toBeLessThan(AI_DRESSING_ORDER.top);
    expect(AI_DRESSING_ORDER.top).toBeLessThan(AI_DRESSING_ORDER.outerwear);
  });
});
