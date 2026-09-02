/**
 * Usage recording — gateway-facing wrapper around UsageEvent + ledger debit.
 *
 * DESIGN (MASTER_PROJECT_CONTEXT §15):
 *  - Successful upstream calls: record usage event (SUCCESS) and debit credits.
 *  - Failures BEFORE reaching a provider: nothing recorded, nothing debited.
 *  - Upstream failures AFTER dispatch: record usage event (FAILED) with error
 *    metadata for observability; no customer charge is made.
 */
import { db } from "@/lib/db";
import { debitCredits } from "@/server/billing/ledger";
import type { UsageBreakdown } from "@/server/billing/pricing";

export type RecordUsageOpts = {
  requestId: string;
  userId: string;
  organizationId?: string | null; // billing owner (org-anchored ledger rows)
  apiKeyId: string | null;
  modelId: string;
  provider: string;
  breakdown: UsageBreakdown;
  status: "SUCCESS" | "FAILED";
  latencyMs: number;
  errorMessage?: string;
  metadata?: Record<string, unknown>;
  /** Whether to bill the customer (false for upstream failures). */
  billCustomer: boolean;
};

export type RecordUsageResult = {
  usageEventId: string;
  chargedMicros: number;
  balanceMicros: number | null;
  debited: boolean;
};

export async function recordUsage(opts: RecordUsageOpts): Promise<RecordUsageResult> {
  const { breakdown } = opts;

  const event = await db.usageEvent.create({
    data: {
      requestId: opts.requestId,
      userId: opts.userId,
      organizationId: opts.organizationId ?? null, // tenant anchor (Phase 1 §24)
      apiKeyId: opts.apiKeyId,
      modelId: opts.modelId,
      provider: opts.provider,
      inputTokens: breakdown.inputTokens,
      outputTokens: breakdown.outputTokens,
      totalTokens: breakdown.totalTokens,
      computeSeconds: breakdown.computeSeconds,
      providerCostMicros: breakdown.providerCostMicros,
      computeCostMicros: breakdown.computeCostMicros,
      marginMicros: breakdown.marginMicros,
      customerChargeMicros: opts.billCustomer ? breakdown.customerChargeMicros : 0,
      status: opts.status,
      errorMessage: opts.errorMessage,
      latencyMs: opts.latencyMs,
      metadata: opts.metadata ? JSON.stringify(opts.metadata) : undefined,
    },
  });

  if (!opts.billCustomer || breakdown.customerChargeMicros <= 0) {
    return {
      usageEventId: event.id,
      chargedMicros: 0,
      balanceMicros: null,
      debited: false,
    };
  }

  const debit = await debitCredits({
    userId: opts.userId,
    organizationId: opts.organizationId ?? null,
    amountMicros: breakdown.customerChargeMicros,
    type: "USAGE",
    description: `${opts.modelId} request (${breakdown.inputTokens} in / ${breakdown.outputTokens} out)`,
    referenceId: event.id,
    metadata: {
      requestId: opts.requestId,
      model: opts.modelId,
      provider: opts.provider,
      inputTokens: breakdown.inputTokens,
      outputTokens: breakdown.outputTokens,
      computeSeconds: breakdown.computeSeconds,
      providerCostMicros: breakdown.providerCostMicros,
      computeCostMicros: breakdown.computeCostMicros,
      marginMicros: breakdown.marginMicros,
    },
  });

  if (!debit.ok) {
    // Balance raced to zero mid-flight. The usage is real, so the event stands;
    // the shortfall is recorded and reconciliation surfaces it.
    await db.usageEvent.update({
      where: { id: event.id },
      data: {
        errorMessage: "Charge deferred: insufficient credits at settlement",
      },
    });
    return {
      usageEventId: event.id,
      chargedMicros: 0,
      balanceMicros: debit.balanceMicros,
      debited: false,
    };
  }

  return {
    usageEventId: event.id,
    chargedMicros: breakdown.customerChargeMicros,
    balanceMicros: debit.balanceMicros,
    debited: true,
  };
}
