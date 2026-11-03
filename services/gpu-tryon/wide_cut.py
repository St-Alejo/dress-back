"""
Prendas de abajo de corte ancho (palazzo, jean ancho).

Con los ajustes normales (sin segmentar, guía 1,5) FASHN copia la silueta del pantalón que el
modelo ya lleva y un palazzo sale con el corte de un pitillo. Probado en la GPU local:
- segmentar la zona del pantalón y subir la guía a 3 deja que la tela siga la forma de la foto;
- aun así depende mucho de la semilla (con una sale recto y ancho, con otra ceñido al tobillo),
  así que se generan dos y se queda la de bajo más ancho.
- tapar con gris una zona más ancha que las piernas no sirve: el modelo la rellena con fondo.
"""

from __future__ import annotations

import numpy as np

SEEDS = (42, 7)
GUIDANCE = 3.0


def hem_width(seg: np.ndarray, labels: tuple[int, ...]) -> float:
    """Ancho del bajo respecto al de la cadera (franjas inferior y superior de la prenda en `seg`)."""
    mask = np.isin(seg, labels)
    rows = np.flatnonzero(mask.sum(axis=1) > 2)
    if len(rows) < 20:
        return 0.0
    top, bottom = rows[0], rows[-1]
    band = max(1, (bottom - top) // 8)

    def extent(y0: int, y1: int) -> int:
        cols = np.flatnonzero(mask[y0:y1].any(axis=0))
        return int(cols[-1] - cols[0]) if len(cols) else 0

    hip = extent(top, top + band)
    return extent(bottom - band, bottom + 1) / hip if hip else 0.0


def pick_widest(candidates: list, measure) -> tuple[int, list[float]]:
    """Índice de la imagen con el bajo más ancho y las medidas de todas (para el log)."""
    widths = [measure(img) for img in candidates]
    return int(np.argmax(widths)), widths
