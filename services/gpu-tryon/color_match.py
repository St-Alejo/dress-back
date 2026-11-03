"""
Ajuste de color tras la difusión: FASHN a veces apaga o desvía el tono de una prenda lisa
(el blazer beige sobre un modelo sale gris). Se mide el color de la tela en la foto de la prenda
y se desplaza hacia él solo la prenda nueva en el resultado.

Conservador a propósito: no toca prendas estampadas, ni lo que la IA no repintó (la ropa que
el modelo ya llevaba), ni desvíos tan grandes que indiquen que la máscara cogió otra cosa.
"""

from __future__ import annotations

import numpy as np
from PIL import Image, ImageFilter

# Etiquetas de fashn_human_parser que ocupa la prenda según la categoría de FASHN.
LABELS = {"tops": ("top",), "bottoms": ("pants", "skirt"), "one-pieces": ("dress",)}

MAX_SPREAD = 8  # dispersión de a/b de la tela por encima de la cual se considera estampada
MAX_SHIFT = 15  # desvío de tono (a/b) a partir del cual no se corrige: la máscara no es fiable
MIN_SHIFT = 3  # por debajo, el tono ya coincide
MAX_L = 8  # la luz de la foto de producto no es la del modelo: la luminosidad se mueve poco


def _lab(img: Image.Image) -> np.ndarray:
    # PIL guarda a y b como enteros con signo dentro de bytes sin signo.
    raw = np.asarray(img.convert("RGB").convert("LAB"))
    out = raw.astype(np.float32)
    out[..., 1:] = raw[..., 1:].view(np.int8)
    return out


def _rgb(lab: np.ndarray) -> Image.Image:
    out = np.empty(lab.shape, np.uint8)
    out[..., 0] = np.clip(lab[..., 0], 0, 255)
    out[..., 1:] = np.clip(lab[..., 1:], -128, 127).astype(np.int8).view(np.uint8)
    return Image.fromarray(out, "LAB").convert("RGB")


def _filter(mask: np.ndarray, *filters) -> np.ndarray:
    img = Image.fromarray(mask.astype(np.uint8) * 255)
    for f in filters:
        img = img.filter(f)
    return np.asarray(img) > 0


def fabric_color(garment: Image.Image) -> tuple[np.ndarray, float]:
    """Color mediano (L, a, b) de la tela y su dispersión de tono; el fondo es el color de la esquina."""
    small = garment.convert("RGB").resize((192, 256))
    rgb = np.asarray(small).astype(np.int16)
    fabric = np.abs(rgb - rgb[2, 2]).max(axis=2) > 30
    lab = _lab(small)[fabric]
    if len(lab) < 100:
        return np.zeros(3, np.float32), float("inf")
    return np.median(lab, axis=0), float(lab[:, 1:].std(axis=0).max())


def match_garment_color(
    person: Image.Image, garment: Image.Image, result: Image.Image, seg: np.ndarray, labels: tuple[int, ...]
) -> tuple[Image.Image, str]:
    """
    Devuelve el resultado con la prenda llevada hacia el tono de su foto y un resumen para el log.
    `seg` es la segmentación del resultado (clase por píxel) y `labels` las clases de la prenda.
    """
    target, spread = fabric_color(garment)
    if spread > MAX_SPREAD:
        return result, "estampada: sin ajuste"
    mask = np.isin(seg, labels)
    # Solo lo que la IA repintó: la ropa que el modelo ya llevaba no se toca.
    before = np.asarray(person.convert("RGB").resize(result.size)).astype(np.int16)
    after = np.asarray(result.convert("RGB")).astype(np.int16)
    mask &= _filter(np.abs(before - after).max(axis=2) > 25, ImageFilter.MedianFilter(5), ImageFilter.MaxFilter(5))
    if mask.mean() < 0.02:
        return result, "sin prenda visible: sin ajuste"
    lab = _lab(result)
    shift = target - np.median(lab[mask], axis=0)
    shift[0] = np.clip(shift[0] * 0.5, -MAX_L, MAX_L)
    tone = float(np.hypot(shift[1], shift[2]))
    if tone > MAX_SHIFT:
        return result, f"desvío {tone:.0f} demasiado grande: sin ajuste"
    if tone < MIN_SHIFT and abs(shift[0]) < 4:
        return result, "el tono ya coincide"
    # Fuera de la prenda, los píxeles originales tal cual (ir y volver de LAB redondea).
    soft = Image.fromarray(mask.astype(np.uint8) * 255).filter(ImageFilter.GaussianBlur(2))
    return Image.composite(_rgb(lab + shift), result.convert("RGB"), soft), f"tono ajustado (L {shift[0]:+.0f}, a {shift[1]:+.0f}, b {shift[2]:+.0f})"
