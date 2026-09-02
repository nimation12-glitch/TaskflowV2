/**
 * TaskFlow-managed inference provider.
 *
 * Runs on TaskFlow platform compute (in this environment, the platform's
 * integrated AI service). This is the "TaskFlow-managed compute" branch of
 * the router: no third-party credentials required, so the gateway works
 * out of the box for all customers on entitled models.
 */
import ZAI from "z-ai-web-dev-sdk";
import {
  ProviderAdapter,
  ProviderChatRequest,
  ProviderChatResult,
  ProviderError,
  estimateTokens,
} from "./types";

export class TaskFlowAIProvider implements ProviderAdapter {
  readonly id = "taskflow";
  readonly displayName = "TaskFlow Managed Compute";

  private client: Awaited<ReturnType<typeof ZAI.create>> | null = null;

  isConfigured(): boolean {
    return true; // platform compute — always available in this deployment
  }

  private async getClient() {
    if (!this.client) {
      this.client = await ZAI.create();
    }
    return this.client;
  }

  async chatCompletion(request: ProviderChatRequest): Promise<ProviderChatResult> {
    const zai = await this.getClient();
    try {
      const completion = (await zai.chat.completions.create({
        messages: request.messages,
        temperature: request.temperature,
        ...(request.maxTokens ? { max_tokens: request.maxTokens } : {}),
      })) as {
        choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };

      const content = completion.choices?.[0]?.message?.content ?? "";
      const finishReason = completion.choices?.[0]?.finish_reason ?? null;

      const usage =
        completion.usage?.prompt_tokens !== undefined
          ? {
              inputTokens: completion.usage.prompt_tokens ?? 0,
              outputTokens: completion.usage.completion_tokens ?? 0,
              estimated: false,
            }
          : estimateTokens(request.messages, content);

      return {
        content,
        model: request.model,
        finishReason,
        usage,
        raw: completion,
      };
    } catch (err) {
      throw new ProviderError(
        `TaskFlow managed inference failed: ${err instanceof Error ? err.message : "unknown error"}`,
        502,
        this.id,
      );
    }
  }
}
