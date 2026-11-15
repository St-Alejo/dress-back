"""
Acabado de una prueba ya vestida, con la edición de imágenes de OpenAI (de pago, con tope de gasto).

FASHN viste camisas, pantalones, vestidos y chaquetas, pero su tela se ve algo plana y no sabe de zapatos
ni de tallas. Aquí, en UNA sola edición por conjunto, la IA de imagen recibe el resultado del probador y
las fotos de catálogo de cada prenda y:

- da a la ropa textura, caída y pliegues de foto real, con los colores y estampados del producto;
- muestra la talla elegida: holgada si es mayor que la recomendada, ajustada si es menor;
- pone en los pies los zapatos del conjunto.

Lecciones de las pruebas reales (nov-2026):
- Editar solo una zona y pegarla sobre la original deja fantasmas: la IA redibuja a la persona entera
  (también la postura de las piernas). Se usa su imagen completa, que además es la más realista.
- La máscara protege la cabeza: la cara se conserva.
- El filtro de seguridad rechaza frases como "do not add or remove garments" (suena a desvestir); el
  texto solo habla de retocar la ropa del catálogo.
"""

from __future__ import annotations

import base64
import io
import logging
from dataclasses import dataclass
from typing import Any

import httpx
from PIL import Image, ImageDraw

from .vision import SpendMeter

log = logging.getLogger("ai-worker.finish")

EDITS_URL = "https://api.openai.com/v1/images/edits"
# USD por millón de tokens: (texto de entrada, imagen de entrada, imagen de salida).
IMAGE_PRICES = {
    "gpt-image-1-mini": (2.0, 2.5, 8.0),
    "gpt-image-1": (5.0, 10.0, 40.0),
    "gpt-image-1.5": (5.0, 8.0, 32.0),
}
MAX_PIECES = 5
# Zona editable, en fracciones de la altura de la persona: desde bajo la barbilla hasta bajo las suelas.
EDIT_TOP, EDIT_BOTTOM = 0.135, 1.03

ROLE = {"top": "top", "outerwear": "jacket", "bottom": "trousers/skirt", "dress": "dress", "footwear": "shoes", "accessory": "accessory"}

LOOSE = {
    "top": "wider through the chest and waist, shoulder seams dropped a little past the shoulders, sleeves and hem a bit longer, with soft extra folds",
    "outerwear": "wider through the chest, shoulders extending past the person's shoulders, sleeves covering part of the hands, with extra folds",
    "bottom": "looser through the hips and legs, the waistband sitting slightly low, the hems longer and stacking over the shoes",
    "dress": "looser through the bust and waist, hanging away from the body, the hem a bit longer",
}
TIGHT = {
    "top": "tighter across the chest and stomach, fabric pulling slightly between buttons, sleeves and hem a bit short",
    "outerwear": "tight across the shoulders and chest, sleeves short at the wrists, unable to close comfortably",
    "bottom": "tight through the hips and thighs with strain lines, the hems a bit short above the ankles",
    "dress": "tight across the bust and hips with strain lines, the hem riding a little higher",
}


class FinishUnavailable(Exception):
    """Sin clave, sin saldo o la API no respondió: la prueba se queda como estaba."""


@dataclass(frozen=True)
class OutfitPiece:
    """Prenda del conjunto: su foto de catálogo y las tallas de diferencia con la recomendada (+1 = una mayor)."""

    category: str
    name: str
    image: bytes
    delta: int = 0


def outfit_prompt(pieces: list[OutfitPiece]) -> str:
    """Una sola instrucción: realismo, tallas y zapatos. Las imágenes 2, 3, ... son las prendas, en orden."""
    lines = []
    for i, p in enumerate(pieces, start=2):
        line = f"- Image {i} is the {ROLE.get(p.category, p.category)} ({p.name})"
        if p.category == "footwear":
            line += ": put these exact shoes on both feet, replacing the current footwear"
        elif p.delta and p.category in LOOSE:
            steps = "one size" if abs(p.delta) == 1 else f"{abs(p.delta)} sizes"
            if p.delta > 0:
                line += f": it is {steps} too large for this person, so it fits loose ({LOOSE[p.category]})"
            else:
                line += f": it is {steps} too small for this person, so it fits tight ({TIGHT[p.category]})"
        else:
            line += ": it fits this person true to size"
        lines.append(line + ".")
    return (
        "Fashion e-commerce catalog photo of a model wearing an outfit. Retouch the clothes so they look "
        "like a real photograph: natural fabric texture, folds and drape, true colors and patterns of each product, "
        "realistic seams, collar and buttons.\n"
        + "\n".join(lines)
        + "\nKeep the model, pose, plain studio background, "
        "framing and camera distance unchanged. Same outfit, only these pieces."
    )


def person_box(img: Image.Image) -> tuple[int, int, int, int]:
    """Caja de la persona sobre el fondo liso del estudio (las fotos del catálogo y de FASHN lo conservan)."""
    small = img.convert("RGB").resize((max(1, img.width // 4), max(1, img.height // 4)))
    w, h = small.size
    px = small.load()
    corners = [px[2, 2], px[w - 3, 2], px[2, h - 3], px[w - 3, h - 3]]
    bg = tuple(sorted(c[i] for c in corners)[1] for i in range(3))
    xs, ys = [], []
    for y in range(h):
        for x in range(w):
            r, g, b = px[x, y]
            if abs(r - bg[0]) + abs(g - bg[1]) + abs(b - bg[2]) > 60:
                xs.append(x)
                ys.append(y)
    if len(xs) < 50:
        return 0, 0, img.width, img.height
    xs.sort()
    ys.sort()
    # Percentiles: una sombra o una mota aislada no estiran la caja.
    lo = lambda v: v[int(len(v) * 0.005)]
    hi = lambda v: v[int(len(v) * 0.995) - 1]
    return lo(xs) * 4, lo(ys) * 4, min(img.width, hi(xs) * 4 + 4), min(img.height, hi(ys) * 4 + 4)


def portrait_canvas(img: Image.Image) -> tuple[Image.Image, tuple[int, int]]:
    """La foto centrada en un lienzo 2:3 (el formato vertical de la API), rellenado con el color del fondo."""
    img = img.convert("RGB")
    w, h = img.size
    W, H = (w, int(w * 1.5)) if h < w * 1.5 else (int(h / 1.5), h)
    bg = img.getpixel((2, h - 3))
    canvas = Image.new("RGB", (W, H), bg)
    offset = ((W - w) // 2, (H - h) // 2)
    canvas.paste(img, offset)
    return canvas, offset


def outfit_zone(img: Image.Image, offset: tuple[int, int] = (0, 0)) -> tuple[int, int, int, int]:
    """Del cuello a los pies, a todo el ancho de la persona con margen (brazos y mangas holgadas)."""
    x0, y0, x1, y1 = person_box(img)
    h, pad = y1 - y0, int((x1 - x0) * 0.10)
    return (
        x0 - pad + offset[0],
        y0 + int(h * EDIT_TOP) + offset[1],
        x1 + pad + offset[0],
        y0 + int(h * EDIT_BOTTOM) + offset[1],
    )


def edit_mask(size: tuple[int, int], zone: tuple[int, int, int, int]) -> bytes:
    """Máscara para la API: transparente = se puede editar; opaco = se conserva."""
    mask = Image.new("RGBA", size, (0, 0, 0, 255))
    ImageDraw.Draw(mask).rectangle(zone, fill=(0, 0, 0, 0))
    return _png(mask)


def _png(img: Image.Image) -> bytes:
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()


def _jpeg(img: Image.Image, side: int = 1024) -> bytes:
    img = img.convert("RGB")
    img.thumbnail((side, side))
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=88)
    return buf.getvalue()


class ImageFinisher:
    def __init__(self, api_key: str, model: str, quality: str, meter: SpendMeter, transport: httpx.AsyncBaseTransport | None = None) -> None:
        self.api_key = api_key
        self.model = model
        self.quality = quality
        self.meter = meter
        self._transport = transport

    @property
    def configured(self) -> bool:
        return bool(self.api_key)

    def _check(self) -> None:
        if not self.api_key:
            raise FinishUnavailable("sin clave de OpenAI")
        if self.meter.exhausted:
            raise FinishUnavailable(f"tope de gasto de OpenAI alcanzado ({self.meter.limit} USD)")

    def _edit_cost(self, usage: Any) -> float:
        text_in, image_in, image_out = IMAGE_PRICES.get(self.model, IMAGE_PRICES["gpt-image-1"])
        try:
            details = usage.get("input_tokens_details") or {}
            text = details.get("text_tokens", 0)
            image = details.get("image_tokens", usage["input_tokens"] - text)
            return (text * text_in + image * image_in + usage["output_tokens"] * image_out) / 1_000_000
        except (KeyError, TypeError, AttributeError):
            return 0.05  # sin datos de uso: se cuenta de más, nunca de menos

    async def _edit(self, images: list[tuple[str, bytes, str]], prompt: str, size: str, mask: bytes | None = None) -> Image.Image:
        self._check()
        data = {"model": self.model, "prompt": prompt, "size": size, "quality": self.quality, "n": "1"}
        files = [("image[]", item) for item in images]
        if mask:
            files.append(("mask", ("mask.png", mask, "image/png")))
        try:
            async with httpx.AsyncClient(transport=self._transport, timeout=180) as http:
                res = await http.post(EDITS_URL, data=data, files=files, headers={"Authorization": f"Bearer {self.api_key}"})
        except httpx.HTTPError as exc:
            raise FinishUnavailable("OpenAI no responde") from exc
        if res.status_code >= 400:
            raise FinishUnavailable(f"OpenAI respondió {res.status_code}: {res.text[:200]}")
        body = res.json()
        cost = self._edit_cost(body.get("usage"))
        self.meter.add(cost)
        log.info("OpenAI edición %s: %.4f USD (acumulado %.4f de %.2f)", self.model, cost, self.meter.spent, self.meter.limit)
        try:
            return Image.open(io.BytesIO(base64.b64decode(body["data"][0]["b64_json"]))).convert("RGB")
        except (KeyError, IndexError, TypeError, ValueError) as exc:
            raise FinishUnavailable("respuesta de OpenAI ilegible") from exc

    async def finish_outfit(self, person: Image.Image, pieces: list[OutfitPiece]) -> Image.Image:
        """Acabado de todo el conjunto en UNA edición (~0,017 USD con gpt-image-1-mini). PNG 1024x1536."""
        pieces = pieces[:MAX_PIECES]
        canvas, offset = portrait_canvas(person)
        images = [("person.png", _png(canvas), "image/png")]
        images += [(f"item{i}.jpg", _jpeg(Image.open(io.BytesIO(p.image)), 640), "image/jpeg") for i, p in enumerate(pieces)]
        mask = edit_mask(canvas.size, outfit_zone(person, offset))
        return await self._edit(images, outfit_prompt(pieces), "1024x1536", mask=mask)
