import hmac
import json
import time
from functools import lru_cache
from typing import Annotated

from fastapi import Depends, FastAPI, File, Form, Header, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.responses import Response
from pydantic import ValidationError

from .config import Settings
from .contract import CONTRACT_VERSION, Manifest, WorkerError, worker_error_handler
from .providers import Credentials, GarmentInput, ProviderRegistry, TransferRequest, TryOnProvider, default_registry
from .vision import ClaudeVision, FallbackVision, GroqVision, OpenAIVision, SpendMeter, VisionClient, VisionUnavailable

app = FastAPI(title="Vestirse AI worker", version="1.0.0")
app.add_exception_handler(WorkerError, worker_error_handler)


@app.exception_handler(RequestValidationError)
async def _validation(request, exc: RequestValidationError):
    # Campos multipart faltantes o mal formados también responden con la forma del contrato.
    first = exc.errors()[0] if exc.errors() else {}
    where = ".".join(str(p) for p in first.get("loc", []))
    return await worker_error_handler(request, WorkerError("bad-input", f"petición inválida: {where}"))


@lru_cache
def get_settings() -> Settings:
    return Settings()


@lru_cache
def get_registry() -> ProviderRegistry:
    return default_registry()


@lru_cache
def _vision(
    provider: str,
    groq_key: str,
    groq_model: str,
    claude_key: str,
    claude_model: str,
    openai_key: str = "",
    openai_model: str = "",
    openai_budget: float = 0.0,
    openai_spend_file: str = "",
) -> VisionClient:
    # Una instancia por configuración: su caché, su límite de llamadas y su gasto viven entre peticiones.
    groq = GroqVision(groq_key, groq_model)
    if provider == "claude":
        return FallbackVision([ClaudeVision(claude_key, claude_model), groq])
    if provider == "openai":
        meter = SpendMeter(openai_spend_file, openai_budget)
        return FallbackVision([OpenAIVision(openai_key, openai_model, meter), groq])
    return groq


def get_vision(settings: Annotated[Settings, Depends(get_settings)]) -> VisionClient:
    return _vision(
        settings.vision_provider.strip().lower(),
        settings.groq_api_key,
        settings.groq_vision_model,
        settings.anthropic_api_key,
        settings.claude_vision_model,
        settings.openai_api_key,
        settings.openai_vision_model,
        settings.openai_budget_usd,
        settings.openai_spend_file,
    )


def require_token(
    settings: Annotated[Settings, Depends(get_settings)],
    x_worker_token: Annotated[str | None, Header()] = None,
) -> None:
    """Solo la API puede llamar al worker (secreto compartido, comparación en tiempo constante)."""
    if settings.worker_token and not hmac.compare_digest(x_worker_token or "", settings.worker_token):
        raise WorkerError("unauthorized", "token del worker inválido")


def get_credentials(
    settings: Annotated[Settings, Depends(get_settings)],
    x_ai_provider: Annotated[str | None, Header()] = None,
    x_ai_model: Annotated[str | None, Header()] = None,
    x_ai_key: Annotated[str | None, Header()] = None,
) -> Credentials:
    return Credentials(provider=x_ai_provider or settings.default_provider, model=x_ai_model, api_key=x_ai_key)


def get_provider(
    credentials: Annotated[Credentials, Depends(get_credentials)],
    settings: Annotated[Settings, Depends(get_settings)],
    registry: Annotated[ProviderRegistry, Depends(get_registry)],
) -> TryOnProvider:
    """El proveedor se resuelve por petición: cambiarlo en el panel de admin no requiere reiniciar."""
    return registry.build(credentials, settings)


@app.get("/health")
def health(registry: Annotated[ProviderRegistry, Depends(get_registry)]) -> dict:
    return {"status": "ok", "contractVersion": CONTRACT_VERSION, "providers": registry.names}


async def _read_limited(file: UploadFile, limit: int, label: str) -> bytes:
    data = await file.read(limit + 1)
    if len(data) > limit:
        raise WorkerError("bad-input", f"{label}: imagen demasiado grande")
    if not data:
        raise WorkerError("bad-input", f"{label}: imagen vacía")
    return data


def _parse_manifest(raw: str) -> Manifest:
    try:
        return Manifest.model_validate(json.loads(raw))
    except (json.JSONDecodeError, ValidationError) as exc:
        raise WorkerError("bad-input", "manifest inválido") from exc


@app.post("/v1/generate", dependencies=[Depends(require_token)])
async def generate(
    person_image: Annotated[UploadFile, File()],
    garment_images: Annotated[list[UploadFile], File()],
    manifest: Annotated[str, Form()],
    provider: Annotated[TryOnProvider, Depends(get_provider)],
    settings: Annotated[Settings, Depends(get_settings)],
) -> Response:
    meta = _parse_manifest(manifest)
    if len(garment_images) != len(meta.garments):
        raise WorkerError("bad-input", "el número de imágenes no coincide con el manifest")
    person = await _read_limited(person_image, settings.max_upload_bytes, "persona")
    garments = [
        GarmentInput(
            image=await _read_limited(garment_images[g.index], settings.max_upload_bytes, f"prenda {g.index}"),
            category=g.category,
            name=g.name,
            color=g.color,
            fit=g.fit,
            photo_type=g.photoType,
        )
        for g in meta.garments
        if g.index < len(garment_images)
    ]
    if len(garments) != len(meta.garments):
        raise WorkerError("bad-input", "índice de prenda fuera de rango")

    started = time.perf_counter()
    try:
        result = await provider.generate(
            TransferRequest(person=person, garments=garments, body_brief=meta.bodyBrief, request_id=meta.requestId)
        )
    finally:
        # Las imágenes nunca se persisten: se liberan al terminar la petición.
        del person, garments
    duration_ms = int((time.perf_counter() - started) * 1000)
    return Response(
        content=result,
        media_type="image/png",
        headers={"X-Engine": getattr(provider, "last_used", None) or provider.name, "X-Duration-Ms": str(duration_ms), "X-Request-Id": meta.requestId},
    )


@app.post("/v1/providers/test", dependencies=[Depends(require_token)])
async def test_provider(provider: Annotated[TryOnProvider, Depends(get_provider)]) -> dict:
    return {"ok": True, "provider": provider.name, "detail": await provider.test()}


@app.post("/v1/photo/inspect", dependencies=[Depends(require_token)])
async def inspect_photo(
    image: Annotated[UploadFile, File()],
    vision: Annotated[VisionClient, Depends(get_vision)],
    settings: Annotated[Settings, Depends(get_settings)],
) -> dict:
    """Control de calidad de la foto. `checked: false` = no se pudo analizar; nunca es motivo para rechazarla."""
    data = await _read_limited(image, settings.max_upload_bytes, "foto")
    try:
        return {"checked": True, **await vision.inspect_photo(data)}
    except VisionUnavailable:
        return {"checked": False, "ok": True, "reason": None}


@app.post("/v1/garment/describe", dependencies=[Depends(require_token)])
async def describe_garment(
    image: Annotated[UploadFile, File()],
    vision: Annotated[VisionClient, Depends(get_vision)],
    settings: Annotated[Settings, Depends(get_settings)],
) -> dict:
    """Sugerencias de etiquetado para el alta de una prenda. Sin análisis, la lista viene vacía."""
    data = await _read_limited(image, settings.max_upload_bytes, "prenda")
    try:
        return {"checked": True, "suggestion": await vision.describe_garment(data)}
    except VisionUnavailable:
        return {"checked": False, "suggestion": {}}


@app.post("/v1/body/estimate", dependencies=[Depends(require_token)])
async def estimate_body(
    image: Annotated[UploadFile, File()],
    height_cm: Annotated[float, Form(alias="heightCm")],
    vision: Annotated[VisionClient, Depends(get_vision)],
    settings: Annotated[Settings, Depends(get_settings)],
) -> dict:
    """Medidas estimadas para la talla. `checked: false` = sin análisis; la talla sigue saliendo de la altura."""
    data = await _read_limited(image, settings.max_upload_bytes, "foto")
    try:
        return {"checked": True, **await vision.estimate_body(data, height_cm)}
    except VisionUnavailable:
        return {"checked": False, "usable": False, "reason": None}
