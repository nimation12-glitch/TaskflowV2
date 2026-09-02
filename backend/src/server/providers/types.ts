/**
 * Provider abstraction (MASTER_PROJECT_CONTEXT §32).
 *
 * Customer → TaskFlow API Gateway → Model Router → ProviderAdapter → upstream.
 *
 * Every provider implements the same minimal chat interface. TaskFlow's
 * gateway, metering and billing only ever talk to this interface, so
 * providers can be added/replaced without redesigning the platform.
 */

export type ProviderChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type ProviderChatRequest = {
  model: string; // upstream model identifier
  messages: ProviderChatMessage[];
  temperature?: number;
  maxTokens?: number;
  /** Vision-capable requests may pass through multimodal content. */
  raw?: unknown;
};

export type ProviderUsage = {
  inputTokens: number;
  outputTokens: number;
  /** Whether token counts came from the provider or were estimated locally. */
  estimated: boolean;
};

export type ProviderChatResult = {
  content: string;
  model: string;
  finishReason: string | null;
  usage: ProviderUsage;
  raw: unknown; // provider-native payload (kept for the response envelope)
};

export interface ProviderAdapter {
  /** Provider identifier (matches AiModel.provider). */
  readonly id: string;
  /** Human-readable name for logs/metrics. */
  readonly displayName: string;
  /** Whether the adapter has credentials/config to run right now. */
  isConfigured(): boolean;
  chatCompletion(request: ProviderChatRequest): Promise<ProviderChatResult>;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly status: number = 502,
    public readonly provider: string = "unknown",
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

/**
 * Token estimation fallback for upstreams that do not return usage.
 * ≈ chars/4 for English text — documented, deliberately conservative.
 */
export function estimateTokens(messages: ProviderChatMessage[], output: string): ProviderUsage {
  const inputChars = messages.reduce((sum, m) => sum + m.content.length, 0);
  return {
    inputTokens: Math.ceil(inputChars / 4),
    outputTokens: Math.ceil(output.length / 4),
    estimated: true,
  };
}
