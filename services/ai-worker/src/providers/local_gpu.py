"""
FASHN VTON v1.5 en una GPU propia (services/gpu-tryon/server.py), sin cuota de Hugging Face.

Va primero en `hf-chain` cuando LOCAL_TRYON_URL está definido: si el servidor no responde,
la cadena sigue con los Spaces gratuitos como siempre.
"""

from __future__ import annotations

import base64
import io

import httpx

from ..contract import WorkerError
from .base import TransferRequest, TryOnProvider
from .hf_space import GARMENT_BOX, PERSON_BOX, _fit

CATEGORY = {"top": "tops", "outerwear": "tops", "bottom": "bottoms", "dress": "one-pieces"}
# Lo añade la API al descriptor de ajuste de las prendas de corte ancho (fit-brief.ts).
WIDE_CUT = "wide-leg cut"


def _jpeg_b64(img) -> str:
    out = io.BytesIO()
    img.save(out, "JPEG", quality=92)
    return base64.b64encode(out.getvalue()).decode()


class LocalGpuProvider(TryOnProvider):
    name = "local-gpu"
    max_garments = 1
    # ~50 s por imagen (el doble con corte ancho: dos semillas), y más si otra app usa la GPU:
    # en la cadena no rige el tope de 120 s de los Spaces.
    max_seconds: float = 200

    def __init__(self, url: str) -> None:
        self.url = url.rstrip("/")
        # La cadena lo acorta según el tiempo que le quede.
        self.timeout: float = 120

    async def test(self) -> str:
        try:
            async with httpx.AsyncClient() as http:
                res = await http.get(f"{self.url}/health", timeout=5)
        except httpx.HTTPError as exc:
            raise WorkerError("provider-error", "la GPU local no responde") from exc
        if res.status_code != 200:
            raise WorkerError("provider-error", "la GPU local no está lista")
        return "FASHN VTON en la GPU local"

    async def _generate(self, req: TransferRequest) -> bytes:
        garment = req.garments[0]
        body = {
            "person": _jpeg_b64(_fit(req.person, PERSON_BOX, "la foto")),
            "garment": _jpeg_b64(_fit(garment.image, GARMENT_BOX, "la prenda")),
            "category": CATEGORY[garment.category],
            "photoType": garment.photo_type,
            # Sin segmentar (valor por defecto de FASHN): si se segmenta, una camisa de manga larga
            # sobre una camiseta de manga corta sale remangada, porque solo se repinta la zona de la prenda vieja.
            "segmentationFree": True,
            # Palazzo, jean ancho: el servidor los genera de otra forma para no copiar el pitillo original.
            "wideCut": garment.category == "bottom" and WIDE_CUT in garment.fit,
            "steps": 30,
            "seed": 42,
        }
        try:
            async with httpx.AsyncClient() as http:
                res = await http.post(f"{self.url}/tryon", json=body, timeout=self.timeout)
        except httpx.TimeoutException as exc:
            raise WorkerError("timeout", "la GPU local tardó demasiado") from exc
        except httpx.HTTPError as exc:
            raise WorkerError("provider-error", "la GPU local no responde") from exc
        if res.status_code == 400:
            raise WorkerError("bad-input", "la GPU local rechazó las imágenes")
        if res.status_code != 200 or not res.content:
            raise WorkerError("provider-error", "la GPU local falló")
        return res.content
