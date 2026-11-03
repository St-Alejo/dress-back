import { describeFit, WIDE_LEG } from './fit-brief';

describe('describeFit', () => {
  it('avisa del corte ancho solo en prendas de abajo marcadas', () => {
    expect(describeFit(null, 'bottom', [WIDE_LEG])).toBe('regular fit; wide-leg cut, loose and flowing from hip to hem');
    expect(describeFit(null, 'bottom', ['limitation.looseFit'])).toBe('regular fit');
    expect(describeFit(null, 'top', [WIDE_LEG])).toBe('regular fit');
  });
});
