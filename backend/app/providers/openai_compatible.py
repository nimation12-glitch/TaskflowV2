from __future__ import annotations

import time

import httpx

from app.providers.base import ChatCompletionResult, ProviderAdapter, ProviderRequestError

# Bounded retry/backoff for transient failures (429/502/503) — never hammer an
# overloaded upstream provider with immediate retries (see docs/AGENTS.md §58).
RETRYABLE_STATUS = {429, 502, 503, 504}
MAX_RETRIES = 2
BASE_BACKOFF_SECONDS = 0.5


class OpenAICompatibleProvider(ProviderAdapter):
    def __init__(self, name: str, api_base: str, api_key: str):
        self.name = name
        self.api_base = api_base.rstrip("/")
        self.api_key = api_key

    def is_configured(self) -> bool:
        return bool(self.api_key)

    async def health(self) -> bool:
        if not self.is_configured():
            return False
        try:
            async with httpx.AsyncClient(timeout=5) as client:
                resp = await client.get(
                    f"{self.api_base}/models", headers={"Authorization": f"Bearer {self.api_key}"}
                )
                return resp.status_code < 500
        except httpx.HTTPError:
            return False

    async def chat_completion(self, *, model_identifier: str, messages: list[dict], **kwargs) -> ChatCompletionResult:
        if not self.is_configured():
            raise ProviderRequestError(f"Provider '{self.name}' is not configured", status_code=503)

        start = time.monotonic()
        last_error: Exception | None = None

        async with httpx.AsyncClient(timeout=60) as client:
            for attempt in range(MAX_RETRIES + 1):
                try:
                    resp = await client.post(
                        f"{self.api_base}/chat/completions",
                        headers={"Authorization": f"Bearer {self.api_key}"},
                        json={"model": model_identifier, "messages": messages, **kwargs},
                    )
                except httpx.HTTPError as exc:
                    last_error = exc
                    if attempt < MAX_RETRIES:
                        import asyncio

                        await asyncio.sleep(BASE_BACKOFF_SECONDS * (2**attempt))
                        continue
                    raise ProviderRequestError(f"Provider '{self.name}' request failed: {exc}") from exc

                if resp.status_code in RETRYABLE_STATUS and attempt < MAX_RETRIES:
                    import asyncio

                    await asyncio.sleep(BASE_BACKOFF_SECONDS * (2**attempt))
                    continue

                if resp.status_code >= 400:
                    raise ProviderRequestError(
                        f"Provider '{self.name}' returned {resp.status_code}: {resp.text[:500]}",
                        status_code=502,
                    )

                data = resp.json()
                latency_ms = int((time.monotonic() - start) * 1000)
                choice = data["choices"][0]["message"]["content"]
                usage = data.get("usage", {})
                return ChatCompletionResult(
                    content=choice,
                    input_tokens=usage.get("prompt_tokens", 0),
                    output_tokens=usage.get("completion_tokens", 0),
                    raw=data,
                    latency_ms=latency_ms,
                )

        raise ProviderRequestError(f"Provider '{self.name}' request failed after retries: {last_error}")
