/**
 * Model router & provider registry (MASTER_PROJECT_CONTEXT §11, §32).
 *
 * Customer → Gateway → [here] → ProviderAdapter → upstream
 *
 * The router resolves AiModel → provider adapter, checks availability,
 * and never exposes provider internals to the customer-facing API.
 * Adding a provider = implementing ProviderAdapter + registering below.
 */
import { db } from "@/lib/db";
import { providerCredentials } from "@/server/env";
import { ProviderAdapter, ProviderError } from "./types";
import { TaskFlowAIProvider } from "./taskflow-ai";
import { OpenAICompatibleProvider } from "./openai-compatible";

const taskflowProvider = new TaskFlowAIProvider();

function buildRegistry(): Map<string, ProviderAdapter> {
  const registry = new Map<string, ProviderAdapter>();
  registry.set(taskflowProvider.id, taskflowProvider);

  const creds = providerCredentials();
  for (const providerId of Object.keys(creds)) {
    const adapter = new OpenAICompatibleProvider(providerId);
    // Register only when credentials exist — keeps routing honest.
    if (adapter.isConfigured()) registry.set(adapter.id, adapter);
  }
  return registry;
}

const registry = buildRegistry();

export type RoutedModel = {
  modelId: string;
  provider: string;
  upstreamModel: string; // upstream identifier (currently = model slug)
  adapter: ProviderAdapter;
};

/**
 * Resolve a catalog model to a live provider route.
 * Throws typed ProviderErrors the gateway maps to customer-facing codes.
 *
 * Honesty guard (MASTER_PROJECT_CONTEXT §6): a model whose registry status is
 * not LIVE is refused regardless of adapter availability, and a LIVE model
 * whose provider is not configured on this deployment returns an honest 503.
 */
export async function routeModel(modelId: string): Promise<RoutedModel> {
  const model = await db.aiModel.findUnique({ where: { id: modelId } });
  if (!model || !model.isActive) {
    throw new ProviderError(`Model '${modelId}' not found on TaskFlow`, 404, "router");
  }

  if (model.status && model.status !== "LIVE") {
    throw new ProviderError(
      `Model '${modelId}' is not currently available (status: ${model.status})`,
      503,
      model.provider,
    );
  }

  const adapter = registry.get(model.provider);
  if (!adapter) {
    throw new ProviderError(
      `Model '${modelId}' is temporarily unavailable (provider '${model.provider}' not attached to this deployment)`,
      503,
      model.provider,
    );
  }
  if (!adapter.isConfigured()) {
    throw new ProviderError(
      `Model '${modelId}' is temporarily unavailable (provider '${model.provider}' is not configured)`,
      503,
      model.provider,
    );
  }

  return { modelId: model.id, provider: model.provider, upstreamModel: model.id, adapter };
}

/**
 * Whether a provider id currently has a configured adapter on this deployment.
 * Used to compute a model's EFFECTIVE status: declared LIVE + unconfigured
 * provider ⇒ NOT_CONFIGURED (§6 — never advertise what cannot be served).
 */
export function isProviderConfigured(providerId: string): boolean {
  const adapter = registry.get(providerId);
  return Boolean(adapter?.isConfigured());
}

/** Registry introspection for observability/health. */
export function registrySnapshot(): Array<{ provider: string; displayName: string; configured: boolean }> {
  const creds = providerCredentials();
  const entries: Array<{ provider: string; displayName: string; configured: boolean }> = [
    {
      provider: taskflowProvider.id,
      displayName: taskflowProvider.displayName,
      configured: taskflowProvider.isConfigured(),
    },
  ];
  for (const providerId of Object.keys(creds)) {
    const adapter = new OpenAICompatibleProvider(providerId);
    entries.push({ provider: providerId, displayName: adapter.displayName, configured: adapter.isConfigured() });
  }
  return entries;
}
