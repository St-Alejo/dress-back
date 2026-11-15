import asyncio
import json

import httpx
import pytest
from fastapi.testclient import TestClient

from src.config import Settings
from src.main import app, get_settings, get_vision
from src.vision import FallbackVision, GroqVision, OpenAIVision, SpendMeter, VisionUnavailable

from .conftest import png

BODY = {"usable": True, "reason": None, "chestCm": 96, "waistCm": 82, "hipCm": 100, "shoulderCm": 44, "confidence": "medium"}
USAGE = {"prompt_tokens": 1000, "completion_tokens": 100}


def reply(payload: dict, seen: list | None = None, usage: dict | None = USAGE):
    def handler(request: httpx.Request) -> httpx.Response:
        if seen is not None:
            seen.append(json.loads(request.content))
        body = {"choices": [{"message": {"content": json.dumps(payload)}}]}
        if usage:
            body["usage"] = usage
        return httpx.Response(200, json=body)

    return handler


def openai(handler, meter: SpendMeter | None = None) -> OpenAIVision:
    return OpenAIVision("sk-test", "gpt-4.1-mini", meter or SpendMeter("", 1.0), httpx.MockTransport(handler))


def test_estimates_measurements_with_the_height_in_the_prompt_and_a_cheap_image():
    seen: list = []
    result = asyncio.run(openai(reply(BODY, seen)).estimate_body(png(size=(1200, 1800)), 172))
    assert result == {"usable": True, "reason": None, "chestCm": 96.0, "waistCm": 82.0, "hipCm": 100.0, "shoulderCm": 44.0, "confidence": "medium"}
    parts = seen[0]["messages"][0]["content"]
    assert "172 cm" in parts[0]["text"]
    assert parts[1]["image_url"]["detail"] == "low"
    assert seen[0]["response_format"]["type"] == "json_schema"


def test_out_of_range_values_are_dropped_instead_of_used():
    result = asyncio.run(openai(reply({**BODY, "waistCm": 20, "hipCm": 400})).estimate_body(png(), 170))
    assert "waistCm" not in result and "hipCm" not in result and result["chestCm"] == 96.0


def test_an_unusable_photo_gives_no_numbers():
    result = asyncio.run(openai(reply({**BODY, "usable": False, "reason": "baggy-clothes"})).estimate_body(png(), 170))
    assert result == {"usable": False, "reason": "baggy-clothes"}


def test_absurd_height_is_not_sent():
    with pytest.raises(VisionUnavailable):
        asyncio.run(openai(reply(BODY)).estimate_body(png(), 60))


def test_same_photo_and_height_is_paid_once_but_another_height_is_asked_again():
    seen: list = []
    client = openai(reply(BODY, seen))
    image = png()
    asyncio.run(client.estimate_body(image, 170))
    asyncio.run(client.estimate_body(image, 170))
    asyncio.run(client.estimate_body(image, 180))
    assert len(seen) == 2


def test_spend_is_counted_saved_and_stops_calls_at_the_limit(tmp_path):
    path = tmp_path / "spend.json"
    seen: list = []
    meter = SpendMeter(str(path), limit_usd=0.0006)
    client = openai(reply(BODY, seen), meter)
    asyncio.run(client.estimate_body(png(color=(1, 2, 3, 255)), 170))  # 1000*0.4 + 100*1.6 = 0.00056 USD
    assert meter.spent == pytest.approx(0.00056)
    assert json.loads(path.read_text())["usd"] == pytest.approx(0.00056)
    asyncio.run(client.estimate_body(png(color=(4, 5, 6, 255)), 170))  # aún por debajo: llama y se pasa
    with pytest.raises(VisionUnavailable):
        asyncio.run(client.estimate_body(png(color=(7, 8, 9, 255)), 170))
    assert len(seen) == 2
    assert SpendMeter(str(path), 1.0).spent == pytest.approx(0.00112)  # sobrevive a un reinicio


def test_missing_usage_counts_high_never_low():
    meter = SpendMeter("", 1.0)
    asyncio.run(openai(reply(BODY, usage=None), meter).estimate_body(png(), 170))
    assert meter.spent >= 0.002


def test_openai_failure_falls_back_to_groq():
    groq_calls: list = []
    chain = FallbackVision([openai(lambda r: httpx.Response(401)), GroqVision("g", "m", httpx.MockTransport(reply(BODY, groq_calls)))])
    assert asyncio.run(chain.estimate_body(png(), 170))["usable"] is True
    assert len(groq_calls) == 1


def test_openai_provider_setting_builds_the_chain():
    settings = Settings(vision_provider="openai", groq_api_key="g", openai_api_key="o", openai_spend_file="", _env_file=None)
    chain = get_vision(settings)
    assert isinstance(chain, FallbackVision) and isinstance(chain.clients[0], OpenAIVision)


def test_endpoint_never_blocks_when_vision_is_unavailable():
    settings = Settings(vision_provider="groq", groq_api_key="", worker_token="", _env_file=None)
    app.dependency_overrides[get_settings] = lambda: settings
    try:
        res = TestClient(app).post("/v1/body/estimate", files={"image": ("p.png", png(), "image/png")}, data={"heightCm": "170"})
    finally:
        app.dependency_overrides.clear()
    assert res.status_code == 200 and res.json() == {"checked": False, "usable": False, "reason": None}
