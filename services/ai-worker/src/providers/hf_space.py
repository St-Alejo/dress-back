"""
Motores de try-on servidos como Spaces públicos de Hugging Face (ZeroGPU).

Son gratuitos pero con cuota diaria de GPU por token, y sus firmas pueden cambiar
sin aviso: por eso cada Space se describe con una `SpaceSpec` y `ChainProvider`
pasa al siguiente cuando uno falla o se queda sin cuota.

`gradio_client` solo acepta rutas de archivo: las imágenes se escriben en un
directorio temporal que se borra al terminar la petición.
"""

from __future__ import annotations

import asyncio
import io
import tempfile
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from PIL import Image

from ..contract import WorkerError
from .base import GarmentInput, TransferRequest, TryOnProvider

# Lado de trabajo de los modelos VTON (3:4). Fotos más pequeñas se amplían antes de enviar.
PERSON_BOX = (864, 1296)
GARMENT_BOX = (768, 1024)
# Tiempo total de la cadena: por debajo del timeout de la API (GENERATION_TIMEOUT_SECONDS, 240 s)
# para que el worker responda antes de que la API aborte. Cada motor tiene además un tope propio
# para que, si el primero se cuelga, los siguientes aún tengan turno.
CHAIN_BUDGET_SECONDS = 220
ENGINE_MAX_SECONDS = 120
# Por debajo de esto no vale la pena arrancar otro motor: no alcanzaría a terminar.
MIN_ENGINE_SECONDS = 10

ClientFactory = Callable[[str, str | None, str], Any]
Call = Callable[[str, str, GarmentInput], dict[str, Any]]


@dataclass(frozen=True)
class SpaceSpec:
    name: str
    space: str
    api_name: str
    supported: frozenset[str]
    call: Call
    seconds: int = CHAIN_BUDGET_SECONDS


def _file(path: str) -> Any:
    from gradio_client import handle_file

    return handle_file(path)


def _fashn(person: str, garment: str, g: GarmentInput) -> dict[str, Any]:
    category = {"top": "tops", "outerwear": "tops", "bottom": "bottoms", "dress": "one-pieces"}[g.category]
    return {
        "person_image": _file(person),
        "garment_image": _file(garment),
        "category": category,
        "garment_photo_type": g.photo_type,
        "num_timesteps": 30,
        "guidance_scale": 1.5,
        "seed": 42,
        # Sin segmentación, FASHN conserva la silueta de la ropa original: una camiseta de manga corta
        # sobre una chaqueta de manga larga salía con mangas largas grises. Con segmentación borra la
        # prenda de arriba antes de pintar y la manga queda corta. Las chaquetas sí van sin segmentar:
        # se llevan encima de la ropa y conviene conservar su volumen.
        "segmentation_free": g.category != "top",
    }


def _leffa(person: str, garment: str, g: GarmentInput) -> dict[str, Any]:
    kind = {"top": "upper_body", "outerwear": "upper_body", "bottom": "lower_body", "dress": "dresses"}[g.category]
    return {
        "src_image_path": _file(person),
        "ref_image_path": _file(garment),
        "ref_acceleration": "False",
        "step": 30,
        "scale": 2.5,
        "seed": 42,
        "vt_model_type": "viton_hd" if kind == "upper_body" else "dress_code",
        "vt_garment_type": kind,
        "vt_repaint": "False",
    }


def _idm(person: str, garment: str, g: GarmentInput) -> dict[str, Any]:
    return {
        "dict": {"background": _file(person), "layers": [], "composite": None},
        "garm_img": _file(garment),
        "garment_des": " ".join(p for p in (g.color, g.name) if p)[:120] or "garment",
        "is_checked": True,
        "is_checked_crop": False,
        "denoise_steps": 30,
        "seed": 42,
    }


SPACES: dict[str, SpaceSpec] = {
    s.name: s
    for s in (
        SpaceSpec("hf-fashn", "fashn-ai/fashn-vton-1.5", "/try_on", frozenset({"top", "bottom", "dress", "outerwear"}), _fashn),
        SpaceSpec("hf-leffa", "franciszzj/Leffa", "/leffa_predict_vt", frozenset({"top", "bottom", "dress", "outerwear"}), _leffa),
        # La máscara automática de IDM-VTON solo cubre la parte superior.
        SpaceSpec("hf-idm", "yisol/IDM-VTON", "/tryon", frozenset({"top", "outerwear"}), _idm),
    )
}
CHAIN_ORDER = ("hf-fashn", "hf-leffa", "hf-idm")


def _default_client(space: str, token: str | None, download_dir: str) -> Any:
    from gradio_client import Client

    return Client(space, token=token or None, verbose=False, download_files=download_dir)


def _fit(data: bytes, box: tuple[int, int], label: str) -> Image.Image:
    try:
        img = Image.open(io.BytesIO(data)).convert("RGB")
    except Exception as exc:
        raise WorkerError("bad-input", f"{label} no se pudo leer") from exc
    scale = min(box[0] / img.width, box[1] / img.height)
    return img.resize((max(1, round(img.width * scale)), max(1, round(img.height * scale))), Image.LANCZOS)


def classify(exc: Exception) -> WorkerError:
    """Traduce los fallos de un Space a códigos del contrato, sin filtrar su texto al usuario."""
    if isinstance(exc, WorkerError):
        return exc
    text = f"{type(exc).__name__} {exc}".lower()
    if any(k in text for k in ("quota", "zerogpu", "runs limit", "rate limit", "too many requests", "429")):
        return WorkerError("rate-limited", "cuota de GPU agotada en Hugging Face")
    if any(k in text for k in ("timeout", "timed out")):
        return WorkerError("timeout", "el motor tardó demasiado")
    if any(k in text for k in ("401", "unauthorized", "invalid token", "invalid user token")):
        return WorkerError("not-configured", "token de Hugging Face inválido")
    return WorkerError("provider-error", "el motor de Hugging Face falló")


class HfSpaceProvider(TryOnProvider):
    max_garments = 1

    def __init__(self, spec: SpaceSpec, token: str | None, client_factory: ClientFactory = _default_client) -> None:
        self.spec = spec
        self.name = spec.name
        self.supported = spec.supported
        self.token = token or None
        self._client_factory = client_factory
        # La cadena lo acorta según el tiempo que le quede.
        self.timeout: float = spec.seconds

    async def test(self) -> str:
        def connect() -> None:
            with tempfile.TemporaryDirectory(prefix="vestirse-") as tmp:
                self._client_factory(self.spec.space, self.token, tmp)

        try:
            await asyncio.wait_for(asyncio.to_thread(connect), 60)
        except Exception as exc:
            raise classify(exc) from exc
        return f"{self.spec.space} disponible ({'con token' if self.token else 'anónimo'})"

    async def _generate(self, req: TransferRequest) -> bytes:
        garment = req.garments[0]
        person_img = _fit(req.person, PERSON_BOX, "la foto")
        garment_img = _fit(garment.image, GARMENT_BOX, "la prenda")
        try:
            return await asyncio.wait_for(
                asyncio.to_thread(self._run, person_img, garment_img, garment), self.timeout
            )
        except Exception as exc:
            raise classify(exc) from exc

    def _run(self, person_img: Image.Image, garment_img: Image.Image, garment: GarmentInput) -> bytes:
        with tempfile.TemporaryDirectory(prefix="vestirse-") as tmp:
            person, cloth = str(Path(tmp, "person.jpg")), str(Path(tmp, "garment.jpg"))
            person_img.save(person, "JPEG", quality=92)
            garment_img.save(cloth, "JPEG", quality=92)
            client = self._client_factory(self.spec.space, self.token, tmp)
            result = client.predict(**self.spec.call(person, cloth, garment), api_name=self.spec.api_name)
            first = result[0] if isinstance(result, (list, tuple)) else result
            path = first.get("path") if isinstance(first, dict) else first
            if not path:
                raise WorkerError("provider-error", "el motor no devolvió imagen")
            out = io.BytesIO()
            with Image.open(path) as produced:
                produced.convert("RGB").save(out, format="PNG")
            return out.getvalue()


class ChainProvider(TryOnProvider):
    """
    Prueba los motores en orden y salta al siguiente cuando uno está caído o tarda demasiado.
    La cuota de GPU es de la cuenta (o de la IP), no de cada Space: si un motor responde que
    se agotó, los demás también fallarían, así que se informa de inmediato en vez de esperar.
    """

    name = "hf-chain"
    max_garments = 1

    def __init__(
        self,
        providers: list[TryOnProvider],
        budget_seconds: float = CHAIN_BUDGET_SECONDS,
        per_engine_seconds: float = ENGINE_MAX_SECONDS,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.providers = providers
        self.supported = frozenset().union(*(p.supported for p in providers))
        self.last_used: str | None = None
        self.budget_seconds = budget_seconds
        self.per_engine_seconds = per_engine_seconds
        self._clock = clock

    async def test(self) -> str:
        return await self.providers[0].test()

    async def _generate(self, req: TransferRequest) -> bytes:
        category = req.garments[0].category
        last: WorkerError | None = None
        deadline = self._clock() + self.budget_seconds
        for provider in self.providers:
            if category not in provider.supported:
                continue
            remaining = deadline - self._clock()
            if remaining < MIN_ENGINE_SECONDS:
                raise last or WorkerError("timeout", "los motores tardaron demasiado")
            # Cada proveedor se crea por petición (registry), así que ajustar su plazo no afecta a otras.
            # Un motor puede pedir otro tope (la GPU local: esperarla vale más que caer a un Space sin cuota).
            if hasattr(provider, "timeout"):
                provider.timeout = min(remaining, getattr(provider, "max_seconds", self.per_engine_seconds))
            try:
                image = await provider.generate(req)
                self.last_used = provider.name
                return image
            except WorkerError as err:
                if not err.retryable or err.code == "rate-limited":
                    raise
                last = err
        raise last or WorkerError("unsupported", f"categoría no soportada: {category}")


def chain(
    token: str | None,
    client_factory: ClientFactory = _default_client,
    budget_seconds: float = CHAIN_BUDGET_SECONDS,
    first: list[TryOnProvider] | None = None,
) -> ChainProvider:
    """`first`: motores que van antes de los Spaces (p. ej. la GPU local, sin cuota)."""
    spaces = [HfSpaceProvider(SPACES[n], token, client_factory) for n in CHAIN_ORDER]
    return ChainProvider([*(first or []), *spaces], budget_seconds)
