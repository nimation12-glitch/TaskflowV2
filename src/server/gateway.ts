/**
 * TaskFlow AI Gateway pipeline (MASTER_PROJECT_CONTEXT §15).
 *
 *  Authenticate API key → identify customer → identify subscription
 *  → check entitlement → check rate limit → check credit balance
 *  → validate model access → route request → receive response
 *  → calculate usage → record usage event → deduct credits → respond.
 *
 * BILLING SAFETY: usage is only billed when an upstream call succeeded.
 * Nothing is debited for requests that never reached a provider (§15, §29).
 * Customer-supplied usage/pricing values are never trusted (§29).
 */
import { randomBytes } from "crypto";
import { db } from "@/lib/db";
import { authenticateApiKey } from "@/server/auth/api-keys";
import { planEntitled } from "@/server/billing/subscription";
import { checkRateLimit, tryAcquireConcurrency, releaseConcurrency } from "@/server/ratelimit";
import { priceUsage } from "@/server/billing/pricing";
import { recordUsage } from "@/server/usage/recorder";
import { routeModel, isProviderConfigured } from "@/server/providers/registry";
import {
  ProviderChatMessage,
  ProviderError,
} from "@/server/providers/types";
import { MICRO_PER_POUND } from "@/lib/money";

export type GatewayRequestBody = {
  model?: unknown;
  messages?: unknown;
  temperature?: unknown;
  max_tokens?: unknown;
  stream?: unknown;
};

export type GatewayError = {
  status: number;
  code: string;
  message: string;
  retryAfterSeconds?: number;
};

type GatewaySuccess = {
  ok: true;
  response: {
    id: string;
    object: "chat.completion";
    created: number;
    model: string;
    choices: Array<{
      index: number;
      message: { role: "assistant"; content: string };
      finish_reason: string | null;
    }>;
    usage: {
      prompt_tokens: number;
      completion_tokens: number;
      total_tokens: number;
      estimated?: boolean;
    };
    taskflow: {
      request_id: string;
      provider: string;
      charge_micros: number;
      balance_micros: number | null;
      latency_ms: number;
    };
  };
};

type GatewayFailure = { ok: false; error: GatewayError };

export type GatewayResult = GatewaySuccess | GatewayFailure;

function gatewayError(status: number, code: string, message: string, retryAfterSeconds?: number): GatewayFailure {
  return { ok: false, error: { status, code, message, retryAfterSeconds } };
}

/** Minimal OpenAI-shaped error payload. */
export function errorPayload(err: GatewayError) {
  return {
    error: {
      message: err.message,
      type: "taskflow_error",
      code: err.code,
    },
  };
}

function parseMessages(raw: unknown): ProviderChatMessage[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const out: ProviderChatMessage[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") return null;
    const role = (item as Record<string, unknown>).role;
    const content = (item as Record<string, unknown>).content;
    if (typeof role !== "string" || typeof content !== "string") return null;
    if (!["system", "user", "assistant"].includes(role)) return null;
    out.push({ role: role as ProviderChatMessage["role"], content });
  }
  return out;
}

export async function handleChatCompletion(
  rawKey: string | null,
  body: GatewayRequestBody,
): Promise<GatewayResult> {
  // ── 1. Authenticate API key ────────────────────────────────
  if (!rawKey) {
    return gatewayError(401, "missing_api_key", "Provide your TaskFlow API key as 'Authorization: Bearer tf_live_…'");
  }
  const auth = await authenticateApiKey(rawKey);
  if (!auth.ok) {
    return gatewayError(auth.status, "invalid_api_key", auth.error);
  }
  const { key } = auth;
  const subscription = key.user.subscription;
  const plan = subscription?.plan;

  // ── 2. Subscription entitlement (a key alone is not access — §19) ──
  if (!subscription || !plan) {
    return gatewayError(403, "no_subscription", "Account has no subscription. Subscribe to a plan to use the API.");
  }
  if (!planEntitled(subscription.status, subscription.pastDueAt)) {
    return gatewayError(
      402,
      "subscription_inactive",
      subscription.status === "PAST_DUE"
        ? "Payment is past due and the grace window has ended. Update billing to continue."
        : `Subscription status '${subscription.status}' does not grant API access. Update billing to continue.`,
    );
  }

  // ── 3. Model request validation ────────────────────────────
  if (typeof body.model !== "string" || !body.model) {
    return gatewayError(400, "invalid_request", "'model' is required");
  }
  const messages = parseMessages(body.messages);
  if (!messages) {
    return gatewayError(400, "invalid_request", "'messages' must be an array of {role, content} objects");
  }
  if (body.stream === true) {
    // Streaming metering lands with the streaming gateway; rejected honestly for now.
    return gatewayError(400, "streaming_unsupported", "Streaming is not enabled yet; use non-streaming requests.");
  }
  const temperature = typeof body.temperature === "number" ? body.temperature : undefined;
  const maxTokens = typeof body.max_tokens === "number" ? Math.floor(body.max_tokens) : undefined;

  // ── 4. Entitlement: is this model allowed for the plan? ────
  const entitlement = await db.modelEntitlement.findUnique({
    where: { modelId_planId: { modelId: body.model, planId: plan.id } },
  });
  if (!entitlement) {
    return gatewayError(
      403,
      "model_not_entitled",
      `Model '${body.model}' is not available on the ${plan.name} plan. Upgrade or choose an entitled model.`,
    );
  }

  // ── 5. Rate limit (per-plan RPM) ───────────────────────────
  const rl = checkRateLimit(key.id, plan.rateLimitPerMinute);
  if (!rl.allowed) {
    return gatewayError(
      429,
      "rate_limit_exceeded",
      `Rate limit of ${rl.limit} requests/minute exceeded for the ${plan.name} plan.`,
      rl.retryAfterSeconds,
    );
  }

  // ── 6. Concurrency cap (per-plan) ──────────────────────────
  if (!tryAcquireConcurrency(key.id, plan.maxConcurrency)) {
    return gatewayError(
      429,
      "concurrency_limit",
      `Concurrency limit of ${plan.maxConcurrency} in-flight requests reached for the ${plan.name} plan.`,
    );
  }

  const requestId = `tf-req-${randomBytes(12).toString("hex")}`;
  const started = Date.now();

  try {
    // ── 7. Credit balance check (gate before spending provider cost) ──
    const balance = key.user.creditAccount?.balanceMicros ?? 0;
    if (balance <= 0) {
      return gatewayError(
        402,
        "insufficient_credits",
        "AI credit balance exhausted. Purchase additional credits or wait for the monthly allowance.",
      );
    }

    // ── 8. Route through the provider abstraction ──────────────
    const route = await routeModel(body.model);

    // ── 9. Upstream call ───────────────────────────────────────
    const result = await route.adapter.chatCompletion({
      model: route.upstreamModel,
      messages,
      temperature,
      maxTokens,
    });
    const latencyMs = Date.now() - started;

    // ── 10. Price usage (server-side only — never customer-supplied) ──
    const priced = await priceUsage(route.modelId, {
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
    });

    // Pricing integrity (§43/§64): a model without a rate card must never be
    // served for free. Record an unbilled FAILED event for the audit trail and
    // refuse the response — the upstream call is written off, never under-billed.
    if (!priced.rateCard) {
      await recordUsage({
        requestId,
        userId: key.userId,
        organizationId: key.organizationId,
        apiKeyId: key.id,
        modelId: route.modelId,
        provider: route.provider,
        breakdown: {
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          totalTokens: result.usage.inputTokens + result.usage.outputTokens,
          computeSeconds: 0,
          providerCostMicros: 0,
          computeCostMicros: 0,
          marginMicros: 0,
          customerChargeMicros: 0,
        },
        status: "FAILED",
        latencyMs,
        errorMessage: "pricing_not_configured: no rate card for model; request not billed",
        metadata: { plan: plan.id, keyPrefix: key.prefix },
        billCustomer: false,
      }).catch(() => undefined);
      return gatewayError(
        500,
        "pricing_not_configured",
        "Model pricing is not configured on this deployment. The request was not served and nothing was charged.",
      );
    }

    // ── 11. Record usage event + deduct credits atomically ─────
    const recorded = await recordUsage({
      requestId,
      userId: key.userId,
      organizationId: key.organizationId,
      apiKeyId: key.id,
      modelId: route.modelId,
      provider: route.provider,
      breakdown: priced.breakdown,
      status: "SUCCESS",
      latencyMs,
      metadata: {
        tokensEstimated: result.usage.estimated,
        rateCard: priced.rateCard,
        plan: plan.id,
        keyPrefix: key.prefix,
      },
      billCustomer: true,
    });

    await db.apiKey.update({
      where: { id: key.id },
      data: { lastUsedAt: new Date() },
    }).catch(() => undefined);

    // ── 12. OpenAI-shaped response with TaskFlow metering block ──
    return {
      ok: true,
      response: {
        id: requestId,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: route.modelId,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: result.content },
            finish_reason: result.finishReason,
          },
        ],
        usage: {
          prompt_tokens: result.usage.inputTokens,
          completion_tokens: result.usage.outputTokens,
          total_tokens: result.usage.inputTokens + result.usage.outputTokens,
          ...(result.usage.estimated ? { estimated: true } : {}),
        },
        taskflow: {
          request_id: requestId,
          provider: route.provider,
          charge_micros: recorded.chargedMicros,
          balance_micros: recorded.balanceMicros,
          latency_ms: latencyMs,
        },
      },
    };
  } catch (err) {
    const latencyMs = Date.now() - started;

    if (err instanceof ProviderError) {
      // Upstream failed → usage event (FAILED) for observability, NO charge.
      // We record zero-token failure events only for provider-dispatch errors,
      // keeping the audit trail without inventing usage.
      await recordUsage({
        requestId,
        userId: key.userId,
        organizationId: key.organizationId,
        apiKeyId: key.id,
        modelId: body.model,
        provider: err.provider,
        breakdown: {
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          computeSeconds: 0,
          providerCostMicros: 0,
          computeCostMicros: 0,
          marginMicros: 0,
          customerChargeMicros: 0,
        },
        status: "FAILED",
        latencyMs,
        errorMessage: err.message,
        metadata: { plan: plan.id, keyPrefix: key.prefix },
        billCustomer: false,
      }).catch(() => undefined);

      return gatewayError(err.status, "provider_error", err.message);
    }

    return gatewayError(500, "gateway_error", "Unexpected gateway error. The request was not billed.");
  } finally {
    releaseConcurrency(key.id);
  }
}

/** OpenAI-style model listing for key holders (entitled + actually usable models). */
export async function handleListModels(rawKey: string | null) {
  if (!rawKey) {
    return gatewayError(401, "missing_api_key", "Provide your TaskFlow API key as 'Authorization: Bearer tf_live_…'");
  }
  const auth = await authenticateApiKey(rawKey);
  if (!auth.ok) return gatewayError(auth.status, "invalid_api_key", auth.error);

  const planId = auth.key.user.subscription?.planId ?? "free";
  const entitlements = await db.modelEntitlement.findMany({
    where: { planId, model: { isActive: true } },
    include: { model: { include: { pricing: true } } },
    orderBy: { model: { sortOrder: "asc" } },
  });

  // Only advertise models that can actually be served right now (§6):
  // registry status LIVE AND provider configured on this deployment.
  const data = entitlements
    .filter((e) => (!e.model.status || e.model.status === "LIVE") && isProviderConfigured(e.model.provider))
    .map((e) => ({
      id: e.model.id,
      object: "model",
      owned_by: e.model.provider,
      created: Math.floor(Date.now() / 1000),
      taskflow: {
        display_name: e.model.displayName,
        capabilities: JSON.parse(e.model.capabilities || "[]"),
        context_window: e.model.contextWindow,
        hosting_mode: e.model.hostingMode,
        status: e.model.status,
        pricing: e.model.pricing
          ? {
              input_per_1k: e.model.pricing.inputCostPer1kMicros / MICRO_PER_POUND,
              output_per_1k: e.model.pricing.outputCostPer1kMicros / MICRO_PER_POUND,
              currency: "GBP",
            }
          : null,
      },
    }));

  return { ok: true as const, data };
}
