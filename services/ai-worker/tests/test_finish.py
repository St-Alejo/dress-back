import asyncio
import base64
import io
import json

import httpx
import pytest
from PIL import Image

from src.finish import FinishUnavailable, ImageFinisher, OutfitPiece, edit_mask, outfit_prompt, outfit_zone, person_box, portrait_canvas
from src.main import get_finisher
from src.vision import SpendMeter

from .conftest import png

USAGE = {"input_tokens": 3000, "output_tokens": 1000, "input_tokens_details": {"text_tokens": 400, "image_tokens": 2600}}


def studio_photo(size=(400, 600)) -> Image.Image:
    """Fondo claro con una "persona" oscura en el centro."""
    img = Image.new("RGB", size, (245, 243, 238))
    w, h = size
    img.paste((40, 60, 120), (w // 3, h // 10, 2 * w // 3, 9 * h // 10))
    return img


def jpeg_bytes(color=(0, 0, 255)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (200, 260), color).save(buf, "JPEG")
    return buf.getvalue()


def edits_reply(seen: list | None = None, status: int = 200, usage: dict | None = USAGE):
    def handler(request: httpx.Request) -> httpx.Response:
        if seen is not None:
            seen.append(request)
        if status != 200:
            return httpx.Response(status, json={"error": {"message": "Your request was rejected by the safety system."}})
        body = {"data": [{"b64_json": base64.b64encode(png(size=(1024, 1536))).decode()}]}
        if usage:
            body["usage"] = usage
        return httpx.Response(200, json=body)

    return handler


def finisher(handler, meter: SpendMeter | None = None, key: str = "sk-test") -> ImageFinisher:
    return ImageFinisher(key, "gpt-image-1-mini", "medium", meter or SpendMeter("", 1.0), httpx.MockTransport(handler))


PIECES = [
    OutfitPiece("top", "Camisa Oxford", jpeg_bytes(), 1),
    OutfitPiece("bottom", "Jean pitillo", jpeg_bytes((10, 10, 60)), 0),
    OutfitPiece("footwear", "Tenis blancos", jpeg_bytes((250, 250, 250)), 0),
]


def test_prompt_describes_each_piece_with_its_size_and_the_shoes():
    text = outfit_prompt(PIECES + [OutfitPiece("dress", "Vestido", b"", -1)])
    assert "Image 2 is the top (Camisa Oxford): it is one size too large" in text
    assert "Image 3 is the trousers/skirt (Jean pitillo): it fits this person true to size" in text
    assert "Image 4 is the shoes (Tenis blancos): put these exact shoes on both feet" in text
    assert "Image 5 is the dress (Vestido): it is one size too small" in text


def test_prompt_avoids_phrases_the_safety_filter_rejects():
    # "remove garments" y hablar del cuerpo hicieron que OpenAI rechazara la petición en las pruebas reales.
    text = outfit_prompt(PIECES).lower()
    assert "remove" not in text and "body" not in text and "skin" not in text


def test_person_box_and_zone_cover_neck_to_feet_with_margin():
    img = studio_photo()
    x0, y0, x1, y1 = person_box(img)
    assert abs(x0 - 133) <= 8 and abs(y0 - 60) <= 8 and abs(x1 - 266) <= 8 and abs(y1 - 540) <= 8
    zx0, zy0, zx1, zy1 = outfit_zone(img)
    assert zx0 < x0 and zx1 > x1  # margen para mangas holgadas
    assert y0 + 40 < zy0 < y0 + 90  # la cabeza queda fuera de la zona editable
    assert zy1 >= y1


def test_portrait_canvas_pads_to_two_by_three_with_the_background():
    canvas, offset = portrait_canvas(Image.new("RGB", (576, 768), (240, 240, 240)))
    assert canvas.size == (576, 864) and offset == (0, 48)
    assert canvas.getpixel((5, 5)) == (240, 240, 240)


def test_mask_is_transparent_only_inside_the_zone():
    mask = Image.open(io.BytesIO(edit_mask((100, 150), (20, 30, 80, 140))))
    assert mask.getpixel((50, 80))[3] == 0
    assert mask.getpixel((5, 5))[3] == 255


def test_finish_sends_person_items_and_mask_and_counts_the_cost():
    seen: list = []
    meter = SpendMeter("", 1.0)
    out = asyncio.run(finisher(edits_reply(seen), meter).finish_outfit(studio_photo(), PIECES))
    assert out.size == (1024, 1536)
    body = seen[0].content
    assert body.count(b'name="image[]"') == 4 and b'name="mask"' not in body
    assert b"gpt-image-1-mini" in body and b"1024x1536" in body
    # 400 texto x 2 + 2600 imagen x 2,5 + 1000 salida x 8 (USD por millón)
    assert meter.spent == pytest.approx((400 * 2 + 2600 * 2.5 + 1000 * 8) / 1_000_000)


def test_finish_caps_the_number_of_pieces():
    seen: list = []
    many = [OutfitPiece("accessory", f"a{i}", jpeg_bytes()) for i in range(8)]
    asyncio.run(finisher(edits_reply(seen)).finish_outfit(studio_photo(), many))
    assert seen[0].content.count(b'name="image[]"') == 1 + 5


def test_finish_without_usage_counts_a_safe_overestimate():
    meter = SpendMeter("", 1.0)
    asyncio.run(finisher(edits_reply(usage=None), meter).finish_outfit(studio_photo(), PIECES))
    assert meter.spent == pytest.approx(0.05)


def test_finish_refuses_without_key_or_budget_and_never_calls_openai():
    seen: list = []
    with pytest.raises(FinishUnavailable, match="sin clave"):
        asyncio.run(finisher(edits_reply(seen), key="").finish_outfit(studio_photo(), PIECES))
    spent = SpendMeter("", 0.10)
    spent.add(0.10)
    with pytest.raises(FinishUnavailable, match="tope"):
        asyncio.run(finisher(edits_reply(seen), spent).finish_outfit(studio_photo(), PIECES))
    assert seen == []


def test_finish_reports_a_rejection_without_charging():
    meter = SpendMeter("", 1.0)
    with pytest.raises(FinishUnavailable, match="400"):
        asyncio.run(finisher(edits_reply(status=400), meter).finish_outfit(studio_photo(), PIECES))
    assert meter.spent == 0


def finish_form(manifest: dict, items: int = 3):
    buf = io.BytesIO()
    studio_photo().save(buf, "PNG")
    files = [("person_image", ("p.png", buf.getvalue(), "image/png"))]
    files += [("item_images", (f"i{i}.jpg", jpeg_bytes(), "image/jpeg")) for i in range(items)]
    return {"files": files, "data": {"manifest": json.dumps(manifest)}}


MANIFEST = {"pieces": [{"index": 0, "category": "top", "name": "Camisa", "delta": 1}, {"index": 1, "category": "bottom", "name": "Jean"}, {"index": 2, "category": "footwear", "name": "Tenis"}]}


def test_endpoint_returns_the_finished_png(make_client):
    from src.main import app

    client = make_client()
    app.dependency_overrides[get_finisher] = lambda: finisher(edits_reply())
    res = client.post("/v1/finish", **finish_form(MANIFEST))
    assert res.status_code == 200, res.text
    assert res.headers["content-type"] == "image/png"
    assert res.headers["x-engine"] == "openai:gpt-image-1-mini"
    assert Image.open(io.BytesIO(res.content)).size == (1024, 1536)


def test_endpoint_maps_errors_to_the_contract(make_client):
    from src.main import app

    client = make_client()
    app.dependency_overrides[get_finisher] = lambda: finisher(edits_reply(status=400))
    res = client.post("/v1/finish", **finish_form(MANIFEST))
    assert res.status_code == 451 and res.json()["code"] == "content-policy"

    app.dependency_overrides[get_finisher] = lambda: finisher(edits_reply(), key="")
    res = client.post("/v1/finish", **finish_form(MANIFEST))
    assert res.status_code == 412 and res.json()["code"] == "not-configured"

    bad = {"pieces": [{"index": 5, "category": "top", "name": "x"}]}
    assert client.post("/v1/finish", **finish_form(bad)).status_code == 400
    assert client.post("/v1/finish", **finish_form({"pieces": []})).status_code == 400


def test_a_dress_is_worn_alone_without_trousers():
    text = outfit_prompt([OutfitPiece("dress", "Vestido floral", b"", -1)])
    assert "one-piece dress worn on its own" in text and "no trousers" in text
