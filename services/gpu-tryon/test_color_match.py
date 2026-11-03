"""Pruebas del ajuste de color con imágenes sintéticas: python -m pytest test_color_match.py"""

import numpy as np
from PIL import Image

from color_match import _lab, match_garment_color

SIZE = (60, 90)
TOP = 3


def garment(color, stripes=None):
    """Prenda lisa (o a rayas) sobre fondo claro, como las fotos del catálogo."""
    img = Image.new("RGB", (192, 256), (245, 243, 239))
    cloth = Image.new("RGB", (120, 180), color)
    if stripes:
        px = cloth.load()
        for y in range(0, 180, 20):
            for yy in range(y, min(y + 10, 180)):
                for x in range(120):
                    px[x, yy] = stripes
    img.paste(cloth, (36, 38))
    return img


def scene(top_color, pants=(200, 200, 200)):
    """Persona esquemática: la mitad de arriba lleva la prenda nueva y la de abajo, su pantalón."""
    img = Image.new("RGB", SIZE, pants)
    img.paste(Image.new("RGB", (SIZE[0], SIZE[1] // 2), top_color), (0, 0))
    return img


def seg():
    out = np.zeros(SIZE[::-1], np.uint8)
    out[: SIZE[1] // 2] = TOP
    return out


BEIGE = (205, 182, 147)
PALE = (198, 190, 178)  # el beige apagado que devuelve FASHN
PERSON = scene((90, 90, 90))  # antes llevaba una camiseta gris oscura


def mean_lab(img, rows):
    return _lab(img)[rows].reshape(-1, 3).mean(axis=0)


def test_a_dull_plain_garment_moves_towards_the_photo_tone():
    out, note = match_garment_color(PERSON, garment(BEIGE), scene(PALE), seg(), (TOP,))
    assert note.startswith("tono ajustado")
    target, before, after = _lab(garment(BEIGE))[128, 96], mean_lab(scene(PALE), slice(0, 45)), mean_lab(out, slice(5, 40))
    assert abs(after[2] - target[2]) < abs(before[2] - target[2]) / 3


def test_what_the_ai_did_not_repaint_is_left_alone():
    person = scene((90, 90, 90), pants=(200, 200, 200))
    out, _ = match_garment_color(person, garment(BEIGE), scene(PALE), seg(), (TOP,))
    assert np.array_equal(np.asarray(out)[80:], np.asarray(scene(PALE))[80:])


def test_patterned_garments_are_not_touched():
    result = scene(PALE)
    out, note = match_garment_color(PERSON, garment(BEIGE, stripes=(30, 60, 160)), result, seg(), (TOP,))
    assert out is result and "estampada" in note


def test_a_tone_that_already_matches_is_not_touched():
    result = scene(BEIGE)
    out, note = match_garment_color(PERSON, garment(BEIGE), result, seg(), (TOP,))
    assert out is result and "coincide" in note


def test_a_huge_shift_means_the_mask_is_wrong_and_nothing_changes():
    result = scene((60, 140, 70))  # verde: la máscara no es la prenda beige
    out, note = match_garment_color(PERSON, garment(BEIGE), result, seg(), (TOP,))
    assert out is result and "demasiado grande" in note
