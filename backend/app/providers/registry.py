from __future__ import annotations

from app.config import get_settings
from app.providers.base import ProviderAdapter
from app.providers.openai_compatible import OpenAICompatibleProvider

_settings = get_settings()

_REGISTRY: dict[str, ProviderAdapter] = {
    "NVIDIA": OpenAICompatibleProvider("NVIDIA", _settings.nvidia_api_base, _settings.nvidia_api_key),
    "MOONSHOT": OpenAICompatibleProvider("MOONSHOT", _settings.moonshot_api_base, _settings.moonshot_api_key),
    "OPENROUTER": OpenAICompatibleProvider("OPENROUTER", _settings.openrouter_api_base, _settings.openrouter_api_key),
}


def get_provider(kind: str) -> ProviderAdapter | None:
    return _REGISTRY.get(kind)


def configured_providers() -> list[str]:
    return [k for k, v in _REGISTRY.items() if v.is_configured()]
