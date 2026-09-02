/**
 * Pricing engine — the single place AI usage is priced.
 *
 * charge = (inputCost + outputCost + computeCost) × (1 + marginPercent/100)
 *
 * Rate cards live in the ModelPricing table (per model, configurable) —
 * NEVER hardcoded in handlers. Future extensions (tier multipliers,
 * deployment-specific GPU rates) slot in here without touching the gateway.
 *
 * Costs are computed in float micros from rate cards, then rounded ONCE at
 * the transaction boundary (roundMicros) when debiting/recording.
 */
import { db } from "@/lib/db";
import { roundMicros } from "@/lib/money";

export type UsageBreakdown = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  computeSeconds: number;
  providerCostMicros: number;
  computeCostMicros: number;
  marginMicros: number;
  customerChargeMicros: number; // rounded integer — the amount billed
};

export type PricingResult = {
  breakdown: UsageBreakdown;
  rateCard: {
    inputCostPer1kMicros: number;
    outputCostPer1kMicros: number;
    computePerSecondMicros: number;
    marginPercent: number;
  } | null;
};

export type PriceableUsage = {
  inputTokens: number;
  outputTokens: number;
  computeSeconds?: number;
};

export async function priceUsage(modelId: string, usage: PriceableUsage): Promise<PricingResult> {
  const pricing = await db.modelPricing.findUnique({ where: { modelId } });

  const inputCostPer1kMicros = pricing?.inputCostPer1kMicros ?? 0;
  const outputCostPer1kMicros = pricing?.outputCostPer1kMicros ?? 0;
  const computePerSecondMicros = pricing?.computePerSecondMicros ?? 0;
  const marginPercent = pricing?.marginPercent ?? 0;

  const computeSeconds = usage.computeSeconds ?? 0;
  const providerCost =
    (usage.inputTokens / 1000) * inputCostPer1kMicros +
    (usage.outputTokens / 1000) * outputCostPer1kMicros;
  const computeCost = computeSeconds * computePerSecondMicros;
  const cost = providerCost + computeCost;
  const margin = cost * (marginPercent / 100);
  const charge = roundMicros(cost + margin);

  return {
    breakdown: {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.inputTokens + usage.outputTokens,
      computeSeconds,
      providerCostMicros: roundMicros(providerCost),
      computeCostMicros: roundMicros(computeCost),
      marginMicros: roundMicros(margin),
      customerChargeMicros: charge,
    },
    rateCard: pricing
      ? {
          inputCostPer1kMicros,
          outputCostPer1kMicros,
          computePerSecondMicros,
          marginPercent,
        }
      : null,
  };
}
