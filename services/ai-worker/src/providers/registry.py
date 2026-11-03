"""
Registry + Factory: el proveedor se elige POR PETICIÓN a partir de las
credenciales que manda la API (cabeceras X-AI-*). Registrar uno nuevo es una
línea; ni main.py ni la API cambian.
"""

from __future__ import annotations

from collections.abc import Callable

from ..config import Settings
from ..contract import WorkerError
from .base import Credentials, TryOnProvider
from .hf_space import SPACES, HfSpaceProvider, chain
from .legacy import FalCatVTONProvider, ReplicateProvider
from .local_gpu import LocalGpuProvider
from .mock import MockProvider

Factory = Callable[[Credentials, Settings], TryOnProvider]


class ProviderRegistry:
    def __init__(self) -> None:
        self._factories: dict[str, Factory] = {}

    def register(self, name: str, factory: Factory) -> None:
        self._factories[name] = factory

    @property
    def names(self) -> list[str]:
        return sorted(self._factories)

    def build(self, credentials: Credentials, settings: Settings) -> TryOnProvider:
        factory = self._factories.get(credentials.provider)
        if factory is None:
            raise WorkerError("not-configured", f"proveedor desconocido: {credentials.provider}")
        return factory(credentials, settings)


def default_registry() -> ProviderRegistry:
    r = ProviderRegistry()
    r.register("mock", lambda _c, s: MockProvider(s.mock_delay_seconds))
    # Mismos nombres que AiProvider en packages/shared-types.
    r.register(
        "hf-chain",
        lambda c, s: chain(
            c.api_key or s.hf_token,
            budget_seconds=max(30, s.generation_timeout_seconds - 20),
            first=[LocalGpuProvider(s.local_tryon_url)] if s.local_tryon_url else None,
        ),
    )
    for spec in SPACES.values():
        r.register(spec.name, lambda c, s, spec=spec: HfSpaceProvider(spec, c.api_key or s.hf_token))
    r.register(
        "fal-catvton",
        lambda c, s: FalCatVTONProvider(c.api_key or s.fal_key, c.model or s.fal_model),
    )
    r.register(
        "replicate",
        lambda c, s: ReplicateProvider(c.api_key or s.replicate_api_token, c.model or s.replicate_model_version),
    )
    return r
