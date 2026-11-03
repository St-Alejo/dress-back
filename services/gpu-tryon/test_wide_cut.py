"""Pruebas de la elección del corte ancho: python -m pytest test_wide_cut.py"""

import numpy as np

from wide_cut import hem_width, pick_widest

PANTS = 6


def trousers(hip: int, hem: int, height: int = 80, width: int = 100) -> np.ndarray:
    """Segmentación sintética: un trapecio de la cadera al bajo."""
    seg = np.zeros((height + 20, width), np.uint8)
    for y in range(height):
        half = round((hip + (hem - hip) * y / (height - 1)) / 2)
        seg[10 + y, width // 2 - half : width // 2 + half] = PANTS
    return seg


def test_a_wide_hem_measures_wider_than_a_tapered_one():
    assert hem_width(trousers(40, 70), (PANTS,)) > 1.4
    assert hem_width(trousers(40, 24), (PANTS,)) < 0.8


def test_without_trousers_the_width_is_zero():
    assert hem_width(np.zeros((50, 50), np.uint8), (PANTS,)) == 0.0


def test_the_widest_candidate_wins():
    segs = [trousers(40, 26), trousers(40, 60)]
    best, widths = pick_widest(segs, lambda s: hem_width(s, (PANTS,)))
    assert best == 1 and widths[1] > widths[0]
