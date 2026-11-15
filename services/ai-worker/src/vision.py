"""
Visión (imagen → JSON): control de calidad de la foto de la persona y etiquetado
de prendas. Ningún proveedor genera imágenes; aquí solo describen lo que ven.

Proveedores:
  - Groq (por defecto, gratuito): cupo pequeño (cada imagen cuesta ~2 000 tokens
    de un cupo de 8 000 por minuto).
  - Claude (opcional, de pago): se activa con `VISION_PROVIDER=claude` y una key
    de Anthropic; si falla o no tiene saldo, la petición cae a Groq.
  - OpenAI (opcional, de pago): `VISION_PROVIDER=openai`. Además de lo anterior estima
    contornos (pecho, cintura, cadera) a partir de la foto y la altura que da la persona,
    para recomendar talla. Lleva un tope de gasto acumulado en USD (`OPENAI_BUDGET_USD`).

Para todos, el cliente:
  - reduce la imagen antes de enviarla y manda una sola por petición;
  - recuerda las respuestas por hash de la imagen;
  - no pasa de su cupo por minuto y respeta `retry-after` tras un 429.

Nunca bloquea a la persona: si el proveedor no está configurado, no tiene cupo o
falla, se lanza `VisionUnavailable` y quien llama sigue adelante sin el análisis.
"""

from __future__ import annotations

import base64
import hashlib
import io
import json
import logging
import time
from collections import OrderedDict, deque
from pathlib import Path
from typing import Any

import anthropic
import httpx
from PIL import Image

GROQ_URL = "https://api.groq.com/openai/v1/chat/completions"
OPENAI_URL = "https://api.openai.com/v1/chat/completions"
# Precio por millón de tokens (entrada, salida) para llevar la cuenta del gasto.
OPENAI_PRICES = {"gpt-4.1-mini": (0.40, 1.60), "gpt-4o-mini": (0.15, 0.60), "gpt-4.1-nano": (0.10, 0.40)}
OPENAI_MAX_PER_MINUTE = 10
MAX_SIDE = 768
MAX_PER_MINUTE = 3
# Claude no tiene el cupo gratuito de Groq, pero cada llamada cuesta: el tope es para el gasto.
CLAUDE_MAX_PER_MINUTE = 20
CACHE_SIZE = 256

log = logging.getLogger("vision")

PHOTO_REASONS = ("no-person", "multiple-people", "not-full-body", "not-frontal", "too-dark")
STYLES = (
    "tshirt", "shirt", "hoodie", "sweater", "jacket", "coat", "jeans", "trousers", "shorts",
    "skirt", "dress-a", "dress-wrap", "sneakers", "boots", "scarf", "cap", "bag",
)  # fmt: skip
STYLE_CATEGORY = {
    "tshirt": "top", "shirt": "top", "hoodie": "top", "sweater": "top", "jacket": "outerwear", "coat": "outerwear",
    "jeans": "bottom", "trousers": "bottom", "shorts": "bottom", "skirt": "bottom", "dress-a": "dress",
    "dress-wrap": "dress", "sneakers": "footwear", "boots": "footwear", "scarf": "accessory", "cap": "accessory",
    "bag": "accessory",
}  # fmt: skip

PHOTO_PROMPT = (
    "You check whether a photo is usable for a virtual clothing try-on. Describe only framing and lighting; "
    "never comment on the person's body, weight, age or attractiveness. Reply with a JSON object with exactly "
    'these keys: "people" (integer, number of people clearly visible), "fullBody" (boolean, the person is visible '
    'at least from head to knees), "frontal" (boolean, the person faces the camera, standing), "lightingOk" '
    "(boolean, the person is clearly lit and in focus)."
)
GARMENT_PROMPT = (
    "You label a product photo for a clothing store. Reply with a JSON object with exactly these keys: "
    f'"style" (one of: {", ".join(STYLES)}), "photoType" ("flat-lay" if the garment is shown on its own, laid flat, '
    'on a hanger or on an invisible mannequin; "model" if a person is wearing it), "color" (dominant garment color '
    'as a #rrggbb hex string), "name" (a short product name in Spanish, at most 6 words, no brand).'
)

# Esquemas para las salidas estructuradas de Claude: la respuesta llega siempre como JSON válido.
PHOTO_SCHEMA = {
    "type": "object",
    "properties": {
        "people": {"type": "integer"},
        "fullBody": {"type": "boolean"},
        "frontal": {"type": "boolean"},
        "lightingOk": {"type": "boolean"},
    },
    "required": ["people", "fullBody", "frontal", "lightingOk"],
    "additionalProperties": False,
}
GARMENT_SCHEMA = {
    "type": "object",
    "properties": {
        "style": {"type": "string", "enum": list(STYLES)},
        "photoType": {"type": "string", "enum": ["flat-lay", "model"]},
        "color": {"type": "string"},
        "name": {"type": "string"},
    },
    "required": ["style", "photoType", "color", "name"],
    "additionalProperties": False,
}
BODY_REASONS = ("no-person", "multiple-people", "not-full-body", "not-frontal", "baggy-clothes")
# Rangos plausibles de un adulto (cm). Un valor fuera de rango se descarta en vez de recomendar con él.
BODY_RANGES = {"chestCm": (65, 165), "waistCm": (50, 165), "hipCm": (70, 175), "shoulderCm": (30, 60)}
BODY_PROMPT = (
    "You help a clothing store recommend a garment size. The person in the photo says they are {height} cm tall. "
    "Using that height as the scale and the visible proportions, estimate their body measurements in centimeters "
    "the way a tailor would take them with a tape: chest circumference, natural waist circumference, hip "
    "circumference and shoulder width (straight across the back). Clothes may hide the shape: account for loose "
    "garments instead of measuring the fabric. Never comment on or judge the body, weight, age or attractiveness; "
    'only give numbers. Reply with a JSON object with exactly these keys: "usable" (boolean, one person, standing, '
    'facing the camera, visible at least from head to knees), "reason" (null, or the main problem, one of: '
    + ", ".join(BODY_REASONS)
    + '), "chestCm", "waistCm", "hipCm", "shoulderCm" (numbers, or null if not usable), "confidence" '
    '("low", "medium" or "high").'
)
BODY_SCHEMA = {
    "type": "object",
    "properties": {
        "usable": {"type": "boolean"},
        "reason": {"anyOf": [{"type": "string", "enum": list(BODY_REASONS)}, {"type": "null"}]},
        **{k: {"type": ["number", "null"]} for k in BODY_RANGES},
        "confidence": {"type": "string", "enum": ["low", "medium", "high"]},
    },
    "required": ["usable", "reason", *BODY_RANGES, "confidence"],
    "additionalProperties": False,
}
SCHEMAS = {"photo": PHOTO_SCHEMA, "garment": GARMENT_SCHEMA, "body": BODY_SCHEMA}


class VisionUnavailable(Exception):
    """El análisis no se pudo hacer. Quien llama debe continuar sin él."""


class RetryLater(VisionUnavailable):
    """El proveedor pidió esperar `seconds` antes de volver a llamarlo."""

    def __init__(self, message: str, seconds: float) -> None:
        super().__init__(message)
        self.seconds = seconds


def _jpeg(image: bytes) -> bytes:
    try:
        img = Image.open(io.BytesIO(image)).convert("RGB")
    except Exception as exc:
        raise VisionUnavailable("imagen ilegible") from exc
    img.thumbnail((MAX_SIDE, MAX_SIDE))
    out = io.BytesIO()
    img.save(out, format="JPEG", quality=85)
    return out.getvalue()


def _retry_after(headers: Any, default: float = 60.0) -> float:
    try:
        return float(headers.get("retry-after", default))
    except (TypeError, ValueError):
        return default


class VisionClient:
    """Lo común a todos los proveedores: interpretar la respuesta, caché por imagen y cupo por minuto."""

    label = "visión"
    max_per_minute = MAX_PER_MINUTE

    def __init__(self, clock=time.monotonic) -> None:
        self._clock = clock
        self._calls: deque[float] = deque()
        self._blocked_until = 0.0
        self._cache: OrderedDict[str, dict[str, Any]] = OrderedDict()

    @property
    def configured(self) -> bool:
        raise NotImplementedError

    async def inspect_photo(self, image: bytes) -> dict[str, Any]:
        """Qué tan utilizable es la foto. `reason` es el primer problema encontrado, o None."""
        raw = await self._ask("photo", PHOTO_PROMPT, image)
        people = raw.get("people")
        checks = {
            "no-person": people == 0,
            "multiple-people": isinstance(people, int) and people > 1,
            "not-full-body": raw.get("fullBody") is False,
            "not-frontal": raw.get("frontal") is False,
            "too-dark": raw.get("lightingOk") is False,
        }
        reason = next((r for r in PHOTO_REASONS if checks[r]), None)
        return {"ok": reason is None, "reason": reason}

    async def describe_garment(self, image: bytes) -> dict[str, Any]:
        """Sugerencias para el formulario de alta. Lo que el modelo no devuelva bien se omite."""
        raw = await self._ask("garment", GARMENT_PROMPT, image)
        out: dict[str, Any] = {}
        if raw.get("style") in STYLES:
            out["style"] = raw["style"]
            out["category"] = STYLE_CATEGORY[raw["style"]]
        if raw.get("photoType") in ("flat-lay", "model"):
            out["photoType"] = raw["photoType"]
        color = raw.get("color")
        if isinstance(color, str) and len(color) == 7 and color.startswith("#"):
            try:
                int(color[1:], 16)
                out["color"] = color.lower()
            except ValueError:
                pass
        if isinstance(raw.get("name"), str) and raw["name"].strip():
            out["name"] = raw["name"].strip()[:80]
        return out

    async def estimate_body(self, image: bytes, height_cm: float) -> dict[str, Any]:
        """Contornos estimados para la talla. Solo números en rango; lo dudoso se omite."""
        if not 120 <= height_cm <= 230:
            raise VisionUnavailable("altura fuera de rango")
        raw = await self._ask("body", BODY_PROMPT.format(height=round(height_cm)), image)
        if raw.get("usable") is not True:
            reason = raw.get("reason") if raw.get("reason") in BODY_REASONS else "not-full-body"
            return {"usable": False, "reason": reason}
        out: dict[str, Any] = {"usable": True, "reason": None}
        for name, (low, high) in BODY_RANGES.items():
            value = raw.get(name)
            if isinstance(value, (int, float)) and not isinstance(value, bool) and low <= value <= high:
                out[name] = round(float(value), 1)
        if not any(k in out for k in ("chestCm", "waistCm", "hipCm")):
            return {"usable": False, "reason": "not-full-body"}
        confidence = raw.get("confidence")
        out["confidence"] = confidence if confidence in ("low", "medium", "high") else "low"
        return out

    async def _ask(self, task: str, prompt: str, image: bytes) -> dict[str, Any]:
        if not self.configured:
            raise VisionUnavailable(f"{self.label} sin configurar")
        # El texto entra en la clave: la misma foto con otra altura es otra pregunta.
        key = f"{task}:{hashlib.sha256(prompt.encode()).hexdigest()[:12]}:{hashlib.sha256(image).hexdigest()}"
        if key in self._cache:
            self._cache.move_to_end(key)
            return self._cache[key]

        now = self._clock()
        while self._calls and now - self._calls[0] > 60:
            self._calls.popleft()
        if now < self._blocked_until or len(self._calls) >= self.max_per_minute:
            raise VisionUnavailable(f"sin cupo de {self.label} por ahora")
        self._calls.append(now)

        try:
            parsed = await self._request(task, prompt, _jpeg(image))
        except RetryLater as exc:
            self._blocked_until = self._clock() + exc.seconds
            raise
        if not isinstance(parsed, dict):
            raise VisionUnavailable(f"respuesta de {self.label} ilegible")

        self._cache[key] = parsed
        if len(self._cache) > CACHE_SIZE:
            self._cache.popitem(last=False)
        return parsed

    async def _request(self, task: str, prompt: str, jpeg: bytes) -> Any:
        """Una llamada al proveedor con la imagen ya reducida. Devuelve el JSON decodificado."""
        raise NotImplementedError


class GroqVision(VisionClient):
    label = "Groq"

    def __init__(self, api_key: str, model: str, transport: httpx.AsyncBaseTransport | None = None, clock=time.monotonic) -> None:
        super().__init__(clock)
        self.api_key = api_key
        self.model = model
        self._transport = transport

    @property
    def configured(self) -> bool:
        return bool(self.api_key)

    async def _request(self, task: str, prompt: str, jpeg: bytes) -> Any:
        body = {
            "model": self.model,
            "temperature": 0,
            "max_completion_tokens": 400,
            "response_format": {"type": "json_object"},
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": prompt},
                        {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64," + base64.b64encode(jpeg).decode()}},
                    ],
                }
            ],
        }
        try:
            async with httpx.AsyncClient(transport=self._transport, timeout=30) as http:
                res = await http.post(GROQ_URL, json=body, headers={"Authorization": f"Bearer {self.api_key}"})
        except httpx.HTTPError as exc:
            raise VisionUnavailable("Groq no responde") from exc

        if res.status_code == 429:
            raise RetryLater("Groq pidió esperar", _retry_after(res.headers))
        if res.status_code >= 400:
            raise VisionUnavailable(f"Groq respondió {res.status_code}")
        try:
            return json.loads(res.json()["choices"][0]["message"]["content"])
        except (KeyError, IndexError, TypeError, ValueError) as exc:
            raise VisionUnavailable("respuesta de Groq ilegible") from exc


class ClaudeVision(VisionClient):
    """Visión con Claude (API de Anthropic). Opcional y de pago: sin key se considera sin configurar."""

    label = "Claude"
    max_per_minute = CLAUDE_MAX_PER_MINUTE

    def __init__(self, api_key: str, model: str, client: Any | None = None, clock=time.monotonic) -> None:
        super().__init__(clock)
        self.api_key = api_key
        self.model = model
        # Sin reintentos del SDK: si falla, la cadena pasa a Groq en vez de hacer esperar a la persona.
        self._client = client or (anthropic.AsyncAnthropic(api_key=api_key, max_retries=0, timeout=30.0) if api_key else None)

    @property
    def configured(self) -> bool:
        return bool(self.api_key) and self._client is not None

    async def _request(self, task: str, prompt: str, jpeg: bytes) -> Any:
        try:
            res = await self._client.messages.create(
                model=self.model,
                max_tokens=1024,
                # Tarea de clasificación corta: poco razonamiento basta y abarata la llamada.
                output_config={"effort": "low", "format": {"type": "json_schema", "schema": SCHEMAS[task]}},
                messages=[
                    {
                        "role": "user",
                        "content": [
                            {
                                "type": "image",
                                "source": {"type": "base64", "media_type": "image/jpeg", "data": base64.standard_b64encode(jpeg).decode()},
                            },
                            {"type": "text", "text": prompt},
                        ],
                    }
                ],
            )
        except anthropic.RateLimitError as exc:
            raise RetryLater("Claude pidió esperar", _retry_after(exc.response.headers)) from exc
        except anthropic.APIStatusError as exc:
            # 400 sin saldo, 401 key inválida, 404 modelo inexistente, 5xx: todo se trata como "sin análisis".
            raise VisionUnavailable(f"Claude respondió {exc.status_code}") from exc
        except anthropic.APIConnectionError as exc:
            raise VisionUnavailable("Claude no responde") from exc

        if res.stop_reason in ("refusal", "max_tokens"):
            raise VisionUnavailable(f"Claude no terminó ({res.stop_reason})")
        text = next((b.text for b in res.content if b.type == "text"), None)
        try:
            return json.loads(text)
        except (TypeError, ValueError) as exc:
            raise VisionUnavailable("respuesta de Claude ilegible") from exc


class SpendMeter:
    """Gasto acumulado en USD, guardado en un archivo para que sobreviva a los reinicios del worker."""

    def __init__(self, path: str, limit_usd: float) -> None:
        self.path = Path(path) if path else None
        self.limit = limit_usd
        self.spent = 0.0
        if self.path and self.path.exists():
            try:
                self.spent = float(json.loads(self.path.read_text())["usd"])
            except (OSError, ValueError, KeyError, TypeError):
                self.spent = 0.0

    @property
    def exhausted(self) -> bool:
        return self.spent >= self.limit

    def add(self, usd: float) -> None:
        self.spent += usd
        if self.path:
            try:
                self.path.write_text(json.dumps({"usd": round(self.spent, 6)}))
            except OSError:
                log.warning("no se pudo guardar el gasto de OpenAI en %s", self.path)


class OpenAIVision(VisionClient):
    """Visión con la API de OpenAI. De pago: cada llamada suma su coste y al llegar al tope deja de llamar."""

    label = "OpenAI"
    max_per_minute = OPENAI_MAX_PER_MINUTE

    def __init__(
        self,
        api_key: str,
        model: str,
        meter: SpendMeter,
        transport: httpx.AsyncBaseTransport | None = None,
        clock=time.monotonic,
    ) -> None:
        super().__init__(clock)
        self.api_key = api_key
        self.model = model
        self.meter = meter
        self._transport = transport

    @property
    def configured(self) -> bool:
        return bool(self.api_key)

    def _cost(self, usage: Any) -> float:
        price_in, price_out = OPENAI_PRICES.get(self.model, max(OPENAI_PRICES.values()))
        try:
            return (usage["prompt_tokens"] * price_in + usage["completion_tokens"] * price_out) / 1_000_000
        except (KeyError, TypeError):
            return 0.002  # sin datos de uso: se cuenta de más, nunca de menos

    async def _request(self, task: str, prompt: str, jpeg: bytes) -> Any:
        if self.meter.exhausted:
            raise VisionUnavailable(f"tope de gasto de OpenAI alcanzado ({self.meter.limit} USD)")
        image_url = {"url": "data:image/jpeg;base64," + base64.b64encode(jpeg).decode(), "detail": "low"}
        body = {
            "model": self.model,
            "temperature": 0,
            "max_tokens": 300,
            "response_format": {"type": "json_schema", "json_schema": {"name": task, "strict": True, "schema": SCHEMAS[task]}},
            # "low": la imagen cuenta como unos cientos de tokens; basta para proporciones y encuadre.
            "messages": [{"role": "user", "content": [{"type": "text", "text": prompt}, {"type": "image_url", "image_url": image_url}]}],
        }
        try:
            async with httpx.AsyncClient(transport=self._transport, timeout=30) as http:
                res = await http.post(OPENAI_URL, json=body, headers={"Authorization": f"Bearer {self.api_key}"})
        except httpx.HTTPError as exc:
            raise VisionUnavailable("OpenAI no responde") from exc

        if res.status_code == 429:
            raise RetryLater("OpenAI pidió esperar", _retry_after(res.headers))
        if res.status_code >= 400:
            raise VisionUnavailable(f"OpenAI respondió {res.status_code}")
        try:
            data = res.json()
        except ValueError as exc:
            raise VisionUnavailable("respuesta de OpenAI ilegible") from exc
        cost = self._cost(data.get("usage"))
        self.meter.add(cost)
        log.info("OpenAI %s: %.5f USD (acumulado %.4f de %.2f)", task, cost, self.meter.spent, self.meter.limit)
        try:
            return json.loads(data["choices"][0]["message"]["content"])
        except (KeyError, IndexError, TypeError, ValueError) as exc:
            raise VisionUnavailable("respuesta de OpenAI ilegible") from exc


class FallbackVision(VisionClient):
    """Prueba los proveedores en orden; cada uno conserva su caché y su cupo."""

    def __init__(self, clients: list[VisionClient]) -> None:
        super().__init__()
        self.clients = clients
        self.label = " → ".join(c.label for c in clients)

    @property
    def configured(self) -> bool:
        return any(c.configured for c in self.clients)

    async def _ask(self, task: str, prompt: str, image: bytes) -> dict[str, Any]:
        last: VisionUnavailable = VisionUnavailable("visión sin configurar")
        for client in self.clients:
            try:
                return await client._ask(task, prompt, image)
            except VisionUnavailable as exc:
                last = exc
        raise last
