"use client";

import { AlertTriangle, Clock, Globe, MapPin } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { formatGbp } from "@/lib/utils";
import {
  estimatedHoursRemaining,
  fromPremiumMicros,
  premiumForPreference,
  priceBreakdown,
  bookingTotalMicros,
  reserveHoursFor,
  type PriceBreakdown,
} from "@/lib/gpu-pricing";
import { LOCATION_OPTIONS, PLAN_LIMITS, REGION_NAMES, type GpuSku, type LocationPreference, type PlanCode } from "@/lib/compute-types";

// The ONE place a GPU gets chosen (spec flow: the workspace is the machine —
// its setup picks the GPU, the platform boots it on AWS and billing starts).
// Shared by the workspace wizard and the "Start GPU" dialog so both quote the
// same total £/hour: GPU base rate + region premium + instance storage add-on.

export type GpuSelection = {
  /** null = no GPU yet (workspace keeps storage; a GPU can be started later). */
  gpuSlug: string | null;
  quantity: number;
  location: LocationPreference;
  paymentMode: "pay_as_you_go" | "booking";
  duration: "day" | "week";
};

/** Storage options the GPU instance's root volume accepts (mirrors backend). */
const INSTANCE_STORAGE_OPTIONS = [50, 100, 250, 500];

/** The workspace size that actually boots, per backend `_instance_storage_gb`. */
export function instanceStorageGb(workspaceStorageGb: number): number {
  return INSTANCE_STORAGE_OPTIONS.includes(workspaceStorageGb) ? workspaceStorageGb : 100;
}

/** How many GPUs one order may request on this plan (1..10, plan concurrency). */
export function maxQuantityFor(plan: PlanCode, concurrentUsed: number): number {
  const remaining = Math.max(0, PLAN_LIMITS[plan].concurrentRentals - concurrentUsed);
  return Math.max(1, Math.min(10, remaining));
}

/** A fresh selection: cheapest SKU of the family list, quantity clamped to the plan. */
export function defaultGpuSelection(gpuTypes: GpuSku[], plan: PlanCode, concurrentUsed: number): GpuSelection {
  return {
    gpuSlug: gpuTypes[0]?.slug ?? null,
    quantity: Math.min(1, maxQuantityFor(plan, concurrentUsed)),
    location: "automatic",
    paymentMode: "pay_as_you_go",
    duration: "day",
  };
}

export type GpuAssessment = {
  sku: GpuSku | null;
  pref: { available: boolean; premiumMicros: number; regionCode: string | null; startupSeconds: number | null };
  price: PriceBreakdown | null;
  /** Total £/hour for the whole order — the number the customer pays. */
  hourlyTotalMicros: number;
  bookingTotalMicros: number;
  reserveHours: number;
  reserveNeededMicros: number;
  hoursLeft: number | null;
  maxQuantity: number;
  quantity: number;
  /** Non-null = this configuration cannot launch right now (why). */
  blockReason: string | null;
};

type AssessArgs = {
  gpuTypes: GpuSku[];
  value: GpuSelection;
  plan: PlanCode;
  concurrentUsed: number;
  walletBalanceMicros: number;
  /** Workspace storage — sizes the instance root volume (§24 add-on). */
  storageGb: number;
};

/**
 * The full money picture for a selection: §24 decomposition (base + region
 * premium + storage add-on) × quantity, the §20 wallet reserve, and every
 * reason a launch would be refused — all derived from the same code path the
 * old standalone rental panel used, so the quote never drifts from the server.
 */
export function assessGpu({ gpuTypes, value, plan, concurrentUsed, walletBalanceMicros, storageGb }: AssessArgs): GpuAssessment {
  const limits = PLAN_LIMITS[plan];
  const sku = value.gpuSlug ? (gpuTypes.find((t) => t.slug === value.gpuSlug) ?? null) : null;
  const pref = sku
    ? premiumForPreference(sku, value.location)
    : { available: false, premiumMicros: 0, regionCode: null, startupSeconds: null };
  const price = sku ? priceBreakdown(sku, instanceStorageGb(storageGb), plan, pref.premiumMicros) : null;

  const maxQuantity = maxQuantityFor(plan, concurrentUsed);
  const quantity = Math.min(Math.max(1, value.quantity), maxQuantity);
  const hourlyTotalMicros = price ? price.totalHourlyMicros * quantity : 0;
  const bookingTotal = price ? bookingTotalMicros(price.totalHourlyMicros, value.duration) * quantity : 0;
  const reserveHours = sku ? reserveHoursFor(sku) : 1;
  const reserveNeededMicros = price ? price.totalHourlyMicros * reserveHours * quantity : 0;
  const hoursLeft = price ? estimatedHoursRemaining(walletBalanceMicros, hourlyTotalMicros) : null;

  let blockReason: string | null = null;
  if (sku) {
    if (!pref.available) {
      blockReason = "Not offered in the selected location — try another location or Automatic.";
    } else if (value.paymentMode === "booking" && (!limits.bookingAllowed || !sku.booking_allowed)) {
      blockReason = "Upgrade to Pro to book a GPU for a fixed period.";
    } else if (concurrentUsed >= limits.concurrentRentals) {
      blockReason = "You're at your plan's concurrent GPU limit — stop or terminate one first.";
    } else if (value.paymentMode === "pay_as_you_go" && walletBalanceMicros < reserveNeededMicros) {
      blockReason = "Your wallet balance doesn't cover the required reserve at this rate.";
    }
  }

  return {
    sku,
    pref,
    price,
    hourlyTotalMicros,
    bookingTotalMicros: bookingTotal,
    reserveHours,
    reserveNeededMicros,
    hoursLeft,
    maxQuantity,
    quantity,
    blockReason,
  };
}

/** Group the catalogue by GPU family (e.g. "NVIDIA T4"), cheapest first. */
export function groupFamilies(gpuTypes: GpuSku[]): { label: string; skus: GpuSku[] }[] {
  const byLabel = new Map<string, GpuSku[]>();
  for (const t of gpuTypes) {
    const list = byLabel.get(t.gpu) ?? [];
    list.push(t);
    byLabel.set(t.gpu, list);
  }
  return [...byLabel.entries()].map(([label, skus]) => ({
    label,
    skus: skus.sort((a, b) => a.gpu_count - b.gpu_count || a.price_micros_per_hour - b.price_micros_per_hour),
  }));
}

type GpuPickerProps = {
  gpuTypes: GpuSku[];
  value: GpuSelection;
  onChange: (next: GpuSelection) => void;
  plan: PlanCode;
  concurrentUsed: number;
  walletBalanceMicros: number;
  /** Workspace storage — the instance root volume follows it when legal. */
  storageGb: number;
  /** Wizard: offer "no GPU yet"; the Start-GPU dialog always picks one. */
  allowNone?: boolean;
};

export function GpuPicker({
  gpuTypes,
  value,
  onChange,
  plan,
  concurrentUsed,
  walletBalanceMicros,
  storageGb,
  allowNone = false,
}: GpuPickerProps) {
  const limits = PLAN_LIMITS[plan];
  const families = groupFamilies(gpuTypes);
  const a = assessGpu({ gpuTypes, value, plan, concurrentUsed, walletBalanceMicros, storageGb });
  const sku = a.sku;
  const family = sku ? families.find((f) => f.skus.some((s) => s.slug === sku.slug)) : null;

  if (gpuTypes.length === 0) {
    return <p className="text-sm text-muted-foreground">The GPU catalogue isn&apos;t reachable right now — check back shortly.</p>;
  }

  function patch(next: Partial<GpuSelection>) {
    onChange({ ...value, ...next });
  }

  return (
    <div className="space-y-4">
      {/* ---- Family ---- */}
      <div>
        <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">GPU family</p>
        <div className="flex flex-wrap gap-2">
          {allowNone && (
            <button
              type="button"
              onClick={() => patch({ gpuSlug: null })}
              className={`rounded-md border px-3 py-2 text-left text-sm transition-colors ${
                value.gpuSlug === null ? "border-primary bg-primary/10" : "border-border hover:bg-muted/30"
              }`}
            >
              <span className="block font-medium">No GPU yet</span>
              <span className="block text-[11px] text-muted-foreground">Start one later</span>
            </button>
          )}
          {families.map((f) => {
            const from = Math.min(...f.skus.map((s) => priceBreakdown(s, 0, plan, fromPremiumMicros(s)).totalHourlyMicros));
            const selected = value.gpuSlug !== null && f.skus.some((s) => s.slug === value.gpuSlug);
            return (
              <button
                key={f.label}
                type="button"
                onClick={() => {
                  const keep = f.skus.find((s) => s.slug === value.gpuSlug);
                  patch({ gpuSlug: (keep ?? f.skus[0]).slug });
                }}
                className={`rounded-md border px-3 py-2 text-left text-sm transition-colors ${
                  selected ? "border-primary bg-primary/10" : "border-border hover:bg-muted/30"
                }`}
              >
                <span className="block font-medium">{f.label}</span>
                <span className="block font-mono-data text-[11px] text-muted-foreground">
                  from {formatGbp(from)}/hr
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* ---- Configuration ---- */}
      {sku && (
        <div>
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Configuration</p>
          <div className="grid gap-2 sm:grid-cols-2">
            {(family?.skus ?? [sku]).map((s) => {
              const selected = s.slug === sku.slug;
              const from = priceBreakdown(s, 0, plan, fromPremiumMicros(s)).totalHourlyMicros;
              return (
                <button
                  key={s.slug}
                  type="button"
                  onClick={() => patch({ gpuSlug: s.slug })}
                  className={`rounded-md border p-2.5 text-left transition-colors ${
                    selected ? "border-primary bg-primary/10" : "border-border hover:bg-muted/30"
                  }`}
                >
                  <span className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium">{s.display_name}</span>
                    {s.tier === "ULTRA" && <Badge variant="default">Ultra</Badge>}
                  </span>
                  <span className="mt-0.5 block text-[11px] text-muted-foreground">
                    {s.gpu_count}× {s.gpu.replace("NVIDIA ", "")} · {s.vram_gb}GB VRAM · {s.vcpu} vCPU · {s.ram_gb}GB RAM
                  </span>
                  <span className="mt-1 block font-mono-data text-sm font-semibold">
                    {formatGbp(from)}/hr
                    <span className="ml-1 text-[11px] font-normal text-muted-foreground">from</span>
                  </span>
                </button>
              );
            })}
          </div>
          <p className="mt-1.5 text-[11px] text-muted-foreground">
            Your {plan} plan: up to {limits.concurrentRentals} concurrent GPU{limits.concurrentRentals === 1 ? "" : "s"}
            {concurrentUsed > 0 ? ` (${concurrentUsed} running)` : ""} · storage up to {limits.maxStorageGb}GB per GPU.
          </p>
        </div>
      )}

      {sku && (
        <>
          {/* ---- Quantity ---- */}
          <div>
            <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">GPUs</p>
            <div className="inline-flex items-center gap-1 rounded-md border border-border bg-muted/30 p-1">
              <button
                type="button"
                onClick={() => patch({ quantity: Math.max(1, a.quantity - 1) })}
                disabled={a.quantity <= 1}
                className="rounded-sm px-3 py-1.5 text-sm font-medium transition-colors hover:bg-card disabled:cursor-not-allowed disabled:opacity-40"
                aria-label="Fewer GPUs"
              >
                −
              </button>
              <span className="min-w-24 px-2 text-center text-sm font-medium">
                {a.quantity} × {sku.display_name}
              </span>
              <button
                type="button"
                onClick={() => patch({ quantity: Math.min(a.maxQuantity, a.quantity + 1) })}
                disabled={a.quantity >= a.maxQuantity}
                className="rounded-sm px-3 py-1.5 text-sm font-medium transition-colors hover:bg-card disabled:cursor-not-allowed disabled:opacity-40"
                aria-label="More GPUs"
              >
                +
              </button>
            </div>
            <p className="mt-1.5 text-[11px] text-muted-foreground">
              Up to {a.maxQuantity} identical GPU{a.maxQuantity === 1 ? "" : "s"} per order on your plan. Each GPU bills
              at the same rate.
            </p>
          </div>

          {/* ---- Region ---- */}
          <div>
            <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Location</p>
            <select
              value={value.location}
              onChange={(e) => patch({ location: e.target.value as LocationPreference })}
              className="h-10 w-full rounded-md border border-border bg-muted/40 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
            >
              {LOCATION_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            {a.pref.available ? (
              <p className="mt-1.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                <MapPin className="h-3.5 w-3.5" />
                {value.location === "automatic"
                  ? "Region: automatically selected (cheapest & fastest)"
                  : `Region: ${REGION_NAMES[a.pref.regionCode ?? ""] ?? a.pref.regionCode}`}
                {a.pref.startupSeconds !== null && (
                  <span className="inline-flex items-center gap-1">
                    <Clock className="h-3.5 w-3.5" />
                    usually ready in ~{Math.max(1, Math.round(a.pref.startupSeconds / 60))} min
                  </span>
                )}
              </p>
            ) : (
              <p className="mt-1.5 flex items-center gap-1.5 text-xs text-warning">
                <AlertTriangle className="h-3.5 w-3.5" />
                This GPU isn&apos;t offered in the selected location.
              </p>
            )}
          </div>

          {/* ---- Payment ---- */}
          <div>
            <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Payment</p>
            <div className="inline-flex items-center gap-1 rounded-md border border-border bg-muted/30 p-1">
              <button
                type="button"
                onClick={() => patch({ paymentMode: "pay_as_you_go" })}
                className={`rounded-sm px-3 py-1.5 text-sm font-medium transition-colors ${
                  value.paymentMode === "pay_as_you_go" ? "bg-card panel-edge text-foreground" : "text-muted-foreground"
                }`}
              >
                Pay as you go
              </button>
              <button
                type="button"
                onClick={() => limits.bookingAllowed && sku.booking_allowed && patch({ paymentMode: "booking" })}
                disabled={!limits.bookingAllowed || !sku.booking_allowed}
                className={`rounded-sm px-3 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                  value.paymentMode === "booking" ? "bg-card panel-edge text-foreground" : "text-muted-foreground"
                }`}
              >
                Book for a fixed period
              </button>
            </div>
            {value.paymentMode === "booking" && (
              <div className="mt-2 inline-flex items-center gap-1 rounded-md border border-border bg-muted/30 p-1">
                {(["day", "week"] as const).map((d) => (
                  <button
                    key={d}
                    type="button"
                    onClick={() => patch({ duration: d })}
                    className={`rounded-sm px-3 py-1.5 text-sm font-medium transition-colors ${
                      value.duration === d ? "bg-card panel-edge text-foreground" : "text-muted-foreground"
                    }`}
                  >
                    1 {d}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* ---- Total £/hour ---- */}
          <div className="rounded-md bg-muted/30 p-4">
            {value.paymentMode === "pay_as_you_go" ? (
              <>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">GPU rate ({sku.display_name})</span>
                  <span className="font-mono-data">{formatGbp(a.price!.discountedBaseRateMicros)}/hr</span>
                </div>
                {a.price!.premiumMicros > 0 && (
                  <div className="mt-1 flex justify-between text-sm">
                    <span className="flex items-center gap-1 text-muted-foreground">
                      <Globe className="h-3.5 w-3.5" />
                      Region premium ({REGION_NAMES[a.pref.regionCode ?? ""] ?? "selected region"})
                    </span>
                    <span className="font-mono-data">+{formatGbp(a.price!.premiumMicros)}/hr</span>
                  </div>
                )}
                {a.price!.storageAddOnMicros > 0 && (
                  <div className="mt-1 flex justify-between text-sm">
                    <span className="text-muted-foreground">Instance storage ({instanceStorageGb(storageGb)}GB)</span>
                    <span className="font-mono-data">+{formatGbp(a.price!.storageAddOnMicros)}/hr</span>
                  </div>
                )}
                <div className="mt-1 flex justify-between text-sm">
                  <span className="text-muted-foreground">Quantity</span>
                  <span className="font-mono-data">× {a.quantity} GPU{a.quantity === 1 ? "" : "s"}</span>
                </div>
                <div className="mt-2 flex justify-between border-t border-border pt-2 text-sm font-medium">
                  <span>Total</span>
                  <span className="font-mono-data">{formatGbp(a.hourlyTotalMicros)}/hour</span>
                </div>
                {a.hoursLeft !== null && (
                  <p className="mt-2 text-xs text-muted-foreground">
                    Your wallet balance of {formatGbp(walletBalanceMicros)} covers about{" "}
                    {a.hoursLeft < 1 ? "under an hour" : `${a.hoursLeft.toFixed(1)} hours`} at this rate. Launches
                    reserve {a.reserveHours} hour{a.reserveHours > 1 ? "s" : ""} of cover ({formatGbp(a.reserveNeededMicros)}).
                  </p>
                )}
              </>
            ) : (
              <>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">
                    {formatGbp(a.price!.totalHourlyMicros)}/hr × {value.duration === "day" ? "24 hours" : "168 hours"}
                    {a.quantity > 1 ? ` × ${a.quantity} GPUs` : ""}
                  </span>
                  <span className="font-mono-data">{formatGbp(a.bookingTotalMicros)}</span>
                </div>
                <div className="mt-2 flex justify-between border-t border-border pt-2 text-sm font-medium">
                  <span>Total charge today</span>
                  <span className="font-mono-data">{formatGbp(a.bookingTotalMicros)}</span>
                </div>
              </>
            )}
          </div>

          {a.blockReason && (
            <p className="flex items-center gap-1.5 text-sm text-warning">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              {a.blockReason}
            </p>
          )}
        </>
      )}
    </div>
  );
}
