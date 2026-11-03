import asyncio
import base64
import io
import json

import httpx
import pytest
import respx
from PIL import Image

from src.config import Settings
from src.contract import WorkerError
from src.providers import Credentials, GarmentInput, TransferRequest
from src.providers.local_gpu import LocalGpuProvider
from src.providers.registry import default_registry

from .conftest import png

URL = "http://gpu.local:8020"


def request(category: str = "top") -> TransferRequest:
    return TransferRequest(person=png(size=(200, 300)), garments=[GarmentInput(png(), category, photo_type="flat-lay")])


@respx.mock
def test_sends_both_images_and_the_fashn_settings():
    route = respx.post(f"{URL}/tryon").mock(return_value=httpx.Response(200, content=png()))
    assert asyncio.run(LocalGpuProvider(URL).generate(request("dress")))
    body = json.loads(route.calls.last.request.content)
    assert (body["category"], body["photoType"], body["segmentationFree"]) == ("one-pieces", "flat-lay", True)
    person = Image.open(io.BytesIO(base64.b64decode(body["person"])))
    assert person.size == (864, 1296)  # se amplía al lado de trabajo del modelo


@respx.mock
def test_tops_are_not_segmented_so_long_sleeves_are_not_rolled_up():
    route = respx.post(f"{URL}/tryon").mock(return_value=httpx.Response(200, content=png()))
    asyncio.run(LocalGpuProvider(URL).generate(request("top")))
    assert json.loads(route.calls.last.request.content)["segmentationFree"] is True


@respx.mock
@pytest.mark.parametrize(
    ("response", "code"),
    [
        (httpx.Response(400, json={"detail": "x"}), "bad-input"),
        (httpx.Response(500, json={"detail": "x"}), "provider-error"),
        (httpx.ConnectError("refused"), "provider-error"),
        (httpx.ReadTimeout("slow"), "timeout"),
    ],
)
def test_failures_become_contract_codes(response, code):
    route = respx.post(f"{URL}/tryon")
    route.mock(side_effect=response) if isinstance(response, Exception) else route.mock(return_value=response)
    with pytest.raises(WorkerError) as err:
        asyncio.run(LocalGpuProvider(URL).generate(request()))
    assert err.value.code == code


def test_hf_chain_tries_the_local_gpu_first_only_when_configured():
    registry = default_registry()
    with_gpu = registry.build(Credentials("hf-chain"), Settings(local_tryon_url=URL, _env_file=None))
    without = registry.build(Credentials("hf-chain"), Settings(local_tryon_url="", _env_file=None))
    assert [p.name for p in with_gpu.providers][:2] == ["local-gpu", "hf-fashn"]
    assert [p.name for p in without.providers][0] == "hf-fashn"


def test_hf_chain_waits_longer_for_the_local_gpu_than_for_a_space():
    chain = default_registry().build(Credentials("hf-chain"), Settings(local_tryon_url=URL, _env_file=None))
    gpu = chain.providers[0]
    seen = []

    async def slow(req):
        seen.append(gpu.timeout)
        return png()

    gpu._generate = slow
    asyncio.run(chain.generate(request()))
    assert seen == [200]
