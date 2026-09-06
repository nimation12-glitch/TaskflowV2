import type { GpuTier, PlanCode } from "./compute-types";
import { PLAN_LIMITS } from "./compute-types";

const INCLUDED_STORAGE_GB = 100;
const STORAGE_BLOCK_GB = 100;
const STORAGE_MICROS_PER_BLOCK = 30_000; // £0.03/hr per 100GB block over the included 100GB

/** Storage add-on in micros/hour. £0.03/hr per 100GB block over the included 100GB, rounded up to the nearest block. */
export function storageAddOnMicros(storageGb: number): number {
  const overage = Math.max(0, storageGb - INCLUDED_STORAGE_GB);
  if (overage === 0) return 0;
  const blocks = Math.ceil(overage / STORAGE_BLOCK_GB);
  return blocks * STORAGE_MICROS_PER_BLOCK;
}

/** Applies the plan discount to a tier's base rate. */
export function planAdjustedRateMicros(baseMicros: number, plan: PlanCode): number {
  return Math.round(baseMicros * PLAN_LIMITS[plan].ratesMultiplier);
}

export type PriceBreakdown = {
  baseRateMicros: number;
  discountedBaseRateMicros: number;
  storageAddOnMicros: number;
  totalHourlyMicros: number;
};

export function priceBreakdown(tier: GpuTier, storageGb: number, plan: PlanCode): PriceBreakdown {
  const discountedBaseRateMicros = planAdjustedRateMicros(tier.base_price_micros_per_hour, plan);
  const storageMicros = storageAddOnMicros(storageGb);
  return {
    baseRateMicros: tier.base_price_micros_per_hour,
    discountedBaseRateMicros,
    storageAddOnMicros: storageMicros,
    totalHourlyMicros: discountedBaseRateMicros + storageMicros,
  };
}

export function bookingTotalMicros(hourlyMicros: number, duration: "day" | "week"): number {
  const hours = duration === "day" ? 24 : 24 * 7;
  return hourlyMicros * hours;
}

export function estimatedHoursRemaining(balanceMicros: number, hourlyMicros: number): number | null {
  if (hourlyMicros <= 0) return null;
  return balanceMicros / hourlyMicros;
}
