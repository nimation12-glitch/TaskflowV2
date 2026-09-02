/**
 * GET /api/models — catalog for the signed-in customer's plan.
 * The BACKEND remains authoritative for authorization (§28) — the frontend
 * displays this list but cannot grant access by editing it.
 *
 * Registry honesty (§6/§50): every row carries its declared status,
 * hosting mode and license summary; the EFFECTIVE status combines the
 * declared status with whether the model's provider is actually configured
 * on this deployment (declared LIVE + unconfigured provider ⇒ NOT_CONFIGURED).
 */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getOrgContext, OrgContextError } from "@/server/tenancy/authz";
import { getOrgSubscription } from "@/server/billing/org";
import { ensureCurrentPeriod } from "@/server/billing/subscription";
import { isProviderConfigured } from "@/server/providers/registry";
import { MICRO_PER_POUND } from "@/lib/money";

/** Declared status + runtime provider configuration ⇒ effective status (§6). */
function effectiveStatus(declared: string | null, provider: string): string {
  if (declared && declared !== "LIVE") return declared;
  return isProviderConfigured(provider) ? "LIVE" : "NOT_CONFIGURED";
}

export async function GET(req: NextRequest) {
  let orgId: string;
  try {
    const ctx = await getOrgContext(req);
    orgId = ctx.organization.id;
  } catch (err) {
    if (err instanceof OrgContextError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }

  // Plan entitlement is resolved through the ACTIVE organization (Phase 1 §23).
  let planId = "free";
  const subscription = await getOrgSubscription(orgId);
  if (subscription) {
    const sub = await ensureCurrentPeriod(subscription.id);
    planId = sub.planId;
  }

  const [entitlements, allPlans] = await Promise.all([
    db.modelEntitlement.findMany({
      where: { model: { isActive: true } },
      include: { model: { include: { pricing: true } }, plan: true },
    }),
    db.plan.findMany({ orderBy: { sortOrder: "asc" } }),
  ]);

  // Group by model, annotate tier availability.
  const byModel = new Map<string, {
    model: typeof entitlements[number]["model"];
    plans: string[];
  }>();
  for (const e of entitlements) {
    const entry = byModel.get(e.modelId) ?? { model: e.model, plans: [] };
    entry.plans.push(e.planId);
    byModel.set(e.modelId, entry);
  }

  const models = [...byModel.values()]
    .sort((a, b) => a.model.sortOrder - b.model.sortOrder)
    .map(({ model, plans }) => {
      const status = effectiveStatus(model.status, model.provider);
      return {
        id: model.id,
        displayName: model.displayName,
        provider: model.provider,
        description: model.description,
        capabilities: JSON.parse(model.capabilities || "[]"),
        contextWindow: model.contextWindow,
        status,
        hostingMode: model.hostingMode,
        version: model.version,
        license: model.license,
        sourceUrl: model.sourceUrl,
        availableToYou: plans.includes(planId) && status === "LIVE",
        tierRequirement: plans.includes("free")
          ? "FREE"
          : plans.includes("pro")
            ? "PRO"
            : "MAX",
        plans,
        pricing: model.pricing
          ? {
              inputPer1kMicros: model.pricing.inputCostPer1kMicros,
              outputPer1kMicros: model.pricing.outputCostPer1kMicros,
              inputPer1kGBP: model.pricing.inputCostPer1kMicros / MICRO_PER_POUND,
              outputPer1kGBP: model.pricing.outputCostPer1kMicros / MICRO_PER_POUND,
              marginPercent: model.pricing.marginPercent,
              currency: model.pricing.currency,
            }
          : null,
      };
    });

  return NextResponse.json({ models, currentPlan: planId });
}
