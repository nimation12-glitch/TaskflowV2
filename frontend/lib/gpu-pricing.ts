import type { GpuSku, PlanCode } from "./compute-types";
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

/**
 * Fixed GPU prices (spec §11): plans buy access, not rate discounts, so every
 * plan's multiplier is 1. Kept as an explicit pass-through so the billing path
 * stays honest and any future change is a deliberate one.
 */
export function planAdjustedRateMicros(baseMicros: number, plan: PlanCode): number {
  return Math.round(baseMicros * PLAN_LIMITS[plan].ratesMultiplier);
}

export type PriceBreakdown = {
  baseRateMicros: number;
  discountedBaseRateMicros: number;
  /** Regional service premium (§12/§24) — never plan-discounted. */
  premiumMicros: number;
  storageAddOnMicros: number;
  totalHourlyMicros: number;
};

/**
 * Spec §24 decomposition: discounted base + regional premium + storage add-on
 * = the customer's hourly price. premiumMicros is whatever the launch region
 * (or location preference) adds on top of the base.
 */
export function priceBreakdown(sku: GpuSku, storageGb: number, plan: PlanCode, premiumMicros = 0): PriceBreakdown {
  const discountedBaseRateMicros = planAdjustedRateMicros(sku.effective_price_micros_per_hour, plan);
  const storageMicros = storageAddOnMicros(storageGb);
  return {
    baseRateMicros: sku.price_micros_per_hour,
    discountedBaseRateMicros,
    premiumMicros,
    storageAddOnMicros: storageMicros,
    totalHourlyMicros: discountedBaseRateMicros + premiumMicros + storageMicros,
  };
}

/** Cheapest hourly price a SKU can start at: lowest offered regional premium. */
export function fromPremiumMicros(sku: GpuSku): number {
  if (sku.regions.offered.length === 0) return 0;
  return Math.min(...sku.regions.offered.map((r) => r.premium_micros));
}

/**
 * The premium a given location preference would add, and whether the SKU can
 * be launched there at all (§12 N/A regions are never offered). Automatic
 * picks the cheapest offered region.
 */
export function premiumForPreference(
  sku: GpuSku,
  preference: "automatic" | "uk" | "europe" | "north_america" | "asia"
): { available: boolean; premiumMicros: number; regionCode: string | null; startupSeconds: number | null } {
  const areaByPreference: Record<string, string> = {
    uk: "UK",
    europe: "Europe",
    north_america: "North America",
    asia: "Asia",
  };
  let candidates = sku.regions.offered;
  if (preference !== "automatic") {
    const area = areaByPreference[preference];
    candidates = candidates.filter((r) => r.area === area);
  }
  if (candidates.length === 0) {
    return { available: false, premiumMicros: 0, regionCode: null, startupSeconds: null };
  }
  const best = candidates.reduce((a, b) =>
    b.premium_micros < a.premium_micros || (b.premium_micros === a.premium_micros && b.startup_estimate_seconds < a.startup_estimate_seconds) ? b : a
  );
  return { available: true, premiumMicros: best.premium_micros, regionCode: best.code, startupSeconds: best.startup_estimate_seconds };
}

/** §20: wallet must cover this many hours before launch (ULTRA tier: ≥4). */
export function reserveHoursFor(sku: GpuSku): number {
  const hours = Math.max(sku.minimum_rental_hours || 1, 1);
  return sku.tier === "ULTRA" ? Math.max(hours, 4) : hours;
}

export function bookingTotalMicros(hourlyMicros: number, duration: "day" | "week"): number {
  const hours = duration === "day" ? 24 : 24 * 7;
  return hourlyMicros * hours;
}

export function estimatedHoursRemaining(balanceMicros: number, hourlyMicros: number): number | null {
  if (hourlyMicros <= 0) return null;
  return balanceMicros / hourlyMicros;
}
