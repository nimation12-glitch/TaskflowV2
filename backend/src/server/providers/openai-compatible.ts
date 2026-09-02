/**
 * Generic OpenAI-compatible provider adapter.
 *
 * Covers OpenAI, OpenRouter, Moonshot and NVIDIA — all expose
 * OpenAI-shaped /chat/completions endpoints. One adapter + per-provider
 * base URL/credential from the environment keeps the abstraction small.
 */
import {
  ProviderAdapter,
  ProviderChatRequest,
  ProviderChatResult,
  ProviderError,
  estimateTokens,
} from "./types";

type ProviderConfig = { baseUrl: string; apiKeyEnvId: string };

const PROVIDER_CONFIG: Record<string, ProviderConfig> = {
  openai: { baseUrl: "https://api.openai.com/v1", apiKeyEnvId: "OPENAI_API_KEY" },
  openrouter: { baseUrl: "https://openrouter.ai/api/v1", apiKeyEnvId: "OPENROUTER_API_KEY" },
  moonshot: { baseUrl: "https://api.moonshot.cn/v1", apiKeyEnvId: "MOONSHOT_API_KEY" },
  nvidia: { baseUrl: "https://integrate.api.nvidia.com/v1", apiKeyEnvId: "NVIDIA_API_KEY" },
};

export class OpenAICompatibleProvider implements ProviderAdapter {
  constructor(readonly id: string) {}

  get displayName(): string {
    return `OpenAI-compatible: ${this.id}`;
  }

  private get config(): ProviderConfig {
    const cfg = PROVIDER_CONFIG[this.id];
    if (!cfg) throw new ProviderError(`Unknown provider: ${this.id}`, 500, this.id);
    return cfg;
  }

  isConfigured(): boolean {
    return Boolean(process.env[this.config.apiKeyEnvId]);
  }

  async chatCompletion(request: ProviderChatRequest): Promise<ProviderChatResult> {
    const { baseUrl, apiKeyEnvId } = this.config;
    const apiKey = process.env[apiKeyEnvId];
    if (!apiKey) {
      throw new ProviderError(
        `Provider ${this.id} is not configured upstream. TaskFlow has not attached credentials for this provider yet.`,
        503,
        this.id,
      );
    }

    let res: Response;
    const started = Date.now();
    try {
      res = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
          ...(this.id === "openrouter" ? { "HTTP-Referer": "https://taskflow.web-agent.org", "X-Title": "TaskFlow" } : {}),
        },
        body: JSON.stringify({
          model: request.model,
          messages: request.messages,
          temperature: request.temperature,
          ...(request.maxTokens ? { max_tokens: request.maxTokens } : {}),
        }),
        signal: AbortSignal.timeout(60_000),
      });
    } catch (err) {
      throw new ProviderError(
        `Upstream ${this.id} unreachable after ${Date.now() - started}ms`,
        504,
        this.id,
      );
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new ProviderError(
        `Upstream ${this.id} returned ${res.status}`,
        res.status === 429 ? 429 : 502,
        this.id,
      );
    }

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const content = data.choices?.[0]?.message?.content ?? "";
    const usage =
      data.usage?.prompt_tokens !== undefined
        ? {
            inputTokens: data.usage.prompt_tokens ?? 0,
            outputTokens: data.usage.completion_tokens ?? 0,
            estimated: false,
          }
        : estimateTokens(request.messages, content);

    return {
      content,
      model: request.model,
      finishReason: data.choices?.[0]?.finish_reason ?? null,
      usage,
      raw: data,
    };
  }
}
