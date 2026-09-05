from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass


@dataclass
class ChatCompletionResult:
    content: str
    input_tokens: int
    output_tokens: int
    raw: dict
    latency_ms: int


class ProviderAdapter(ABC):
    """
    Every external model provider (NVIDIA, Moonshot, OpenRouter, ...) implements
    this interface. Business logic never talks to a provider's SDK/HTTP API
    directly — only through this abstraction, so providers can be added or
    swapped without touching the gateway or billing code.
    """

    name: str

    @abstractmethod
    def is_configured(self) -> bool:
        ...

    @abstractmethod
    async def health(self) -> bool:
        ...

    @abstractmethod
    async def chat_completion(self, *, model_identifier: str, messages: list[dict], **kwargs) -> ChatCompletionResult:
        ...


class ProviderNotConfiguredError(Exception):
    pass


class ProviderRequestError(Exception):
    def __init__(self, message: str, status_code: int = 502):
        super().__init__(message)
        self.status_code = status_code
