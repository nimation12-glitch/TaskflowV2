"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Cpu, KeyRound, AlertTriangle, Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { useAction } from "@/lib/hooks/use-action";
import { formatGbp } from "@/lib/utils";
import { priceBreakdown, bookingTotalMicros, estimatedHoursRemaining } from "@/lib/gpu-pricing";
import { PLAN_LIMITS, STORAGE_OPTIONS, type GpuTier, type PlanCode, type SshKey } from "@/lib/compute-types";
import { createRentalAction } from "./actions";

export function RentPanel({
  gpuTypes,
  sshKeys,
  plan,
  walletBalanceMicros,
  concurrentUsed,
}: {
  gpuTypes: GpuTier[];
  sshKeys: SshKey[];
  plan: PlanCode;
  walletBalanceMicros: number;
  concurrentUsed: number;
}) {
  const limits = PLAN_LIMITS[plan];
  const [tierSlug, setTierSlug] = useState(gpuTypes[0]?.slug);
  const [storageGb, setStorageGb] = useState(100);
  const [sshKeyId, setSshKeyId] = useState(sshKeys[0]?.id ?? "");
  const [mode, setMode] = useState<"pay_as_you_go" | "booking">("pay_as_you_go");
  const [duration, setDuration] = useState<"day" | "week">("day");
  const { pending, run } = useAction();

  const tier = gpuTypes.find((t) => t.slug === tierSlug) ?? gpuTypes[0];
  const price = useMemo(() => (tier ? priceBreakdown(tier, storageGb, plan) : null), [tier, storageGb, plan]);
  const bookingTotal = price ? bookingTotalMicros(price.totalHourlyMicros, duration) : 0;
  const hoursLeft = price ? estimatedHoursRemaining(walletBalanceMicros, price.totalHourlyMicros) : null;

  const atConcurrentLimit = concurrentUsed >= limits.concurrentRentals;
  const insufficientBalance = price ? walletBalanceMicros < price.totalHourlyMicros : false;
  const noSshKeys = sshKeys.length === 0;

  function handleSubmit() {
    if (!tier || !sshKeyId) return;
    run(
      () =>
        createRentalAction({
          gpu_type_slug: tier.slug,
          storage_gb: storageGb,
          ssh_key_id: sshKeyId,
          payment_mode: mode,
          ...(mode === "booking" ? { booking_duration: duration } : {}),
        }),
      { success: mode === "pay_as_you_go" ? "GPU rental starting…" : undefined, error: "Couldn't start the rental" }
    );
  }

  if (!tier) {
    return (
      <Card>
        <CardContent className="pt-6 text-sm text-muted-foreground">GPU rental isn't open yet — check back soon.</CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-foreground">
          <Cpu className="h-4 w-4" />
          Rent a GPU
        </CardTitle>
        <CardDescription>
          {concurrentUsed}/{limits.concurrentRentals} concurrent rentals used · {limits.queuePriority} queue priority
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Tier selector */}
        <div>
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">GPU tier</p>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {gpuTypes.map((t) => {
              const p = priceBreakdown(t, 100, plan);
              const discounted = plan !== "FREE";
              const selected = t.slug === tierSlug;
              return (
                <button
                  key={t.slug}
                  onClick={() => setTierSlug(t.slug)}
                  className={`rounded-md border p-3 text-left transition-colors ${
                    selected ? "border-primary bg-primary/10" : "border-border hover:bg-muted/30"
                  }`}
                >
                  <p className="text-sm font-medium">{t.display_name}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {t.gpu} · {t.vram_gb}GB VRAM
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {t.vcpu} vCPU · {t.ram_gb}GB RAM
                  </p>
                  <div className="mt-2 font-mono-data text-sm">
                    {discounted && (
                      <span className="mr-1.5 text-muted-foreground line-through">{formatGbp(t.base_price_micros_per_hour)}</span>
                    )}
                    <span className="font-semibold">{formatGbp(p.discountedBaseRateMicros)}/hr</span>
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Storage selector */}
        <div>
          <div className="mb-2 flex items-center gap-1.5">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Storage</p>
            <Tooltip>
              <TooltipTrigger asChild>
                <button type="button" className="text-muted-foreground hover:text-foreground">
                  <Info className="h-3.5 w-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent className="max-w-xs">
                First 100GB is included in the base rate. Extra storage adds £0.03/hr per 100GB block beyond that.
              </TooltipContent>
            </Tooltip>
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {STORAGE_OPTIONS.map((opt) => {
              const allowed = opt.gb <= limits.maxStorageGb;
              const selected = storageGb === opt.gb;
              return (
                <div key={opt.gb}>
                  <button
                    disabled={!allowed}
                    onClick={() => setStorageGb(opt.gb)}
                    className={`w-full rounded-md border p-2.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                      selected ? "border-primary bg-primary/10" : "border-border hover:bg-muted/30"
                    }`}
                  >
                    {opt.gb}GB
                  </button>
                  {!allowed && (
                    <p className="mt-1 text-[11px] leading-tight text-muted-foreground">
                      Upgrade to {opt.minPlan === "PRO" ? "Pro" : "Max"} for up to {opt.minPlan === "PRO" ? "250GB" : "500GB"}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* SSH key selector */}
        <div>
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">SSH key</p>
          {noSshKeys ? (
            <div className="flex items-center justify-between rounded-md border border-dashed border-border p-3 text-sm">
              <span className="flex items-center gap-2 text-muted-foreground">
                <KeyRound className="h-4 w-4" />
                No SSH keys saved yet
              </span>
              <Link href="/account">
                <Button size="sm" variant="secondary">
                  Add one
                </Button>
              </Link>
            </div>
          ) : (
            <select
              value={sshKeyId}
              onChange={(e) => setSshKeyId(e.target.value)}
              className="h-10 w-full rounded-md border border-border bg-muted/40 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
            >
              {sshKeys.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.label} ({k.fingerprint})
                </option>
              ))}
            </select>
          )}
        </div>

        {/* Payment mode */}
        <div>
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Payment</p>
          <div className="inline-flex items-center gap-1 rounded-md border border-border bg-muted/30 p-1">
            <button
              onClick={() => setMode("pay_as_you_go")}
              className={`rounded-sm px-3 py-1.5 text-sm font-medium transition-colors ${
                mode === "pay_as_you_go" ? "bg-card panel-edge text-foreground" : "text-muted-foreground"
              }`}
            >
              Pay as you go
            </button>
            <button
              onClick={() => limits.bookingAllowed && setMode("booking")}
              disabled={!limits.bookingAllowed}
              className={`rounded-sm px-3 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                mode === "booking" ? "bg-card panel-edge text-foreground" : "text-muted-foreground"
              }`}
            >
              Book for a fixed period
            </button>
          </div>
          {!limits.bookingAllowed && <p className="mt-1.5 text-xs text-muted-foreground">Upgrade to Pro to book a GPU for a fixed period.</p>}

          {mode === "booking" && limits.bookingAllowed && (
            <div className="mt-3 inline-flex items-center gap-1 rounded-md border border-border bg-muted/30 p-1">
              {(["day", "week"] as const).map((d) => (
                <button
                  key={d}
                  onClick={() => setDuration(d)}
                  className={`rounded-sm px-3 py-1.5 text-sm font-medium transition-colors ${
                    duration === d ? "bg-card panel-edge text-foreground" : "text-muted-foreground"
                  }`}
                >
                  1 {d}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Live price */}
        <div className="rounded-md bg-muted/30 p-4">
          {mode === "pay_as_you_go" ? (
            <>
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Base rate ({tier.display_name})</span>
                <span className="font-mono-data">{formatGbp(price!.discountedBaseRateMicros)}/hr</span>
              </div>
              {price!.storageAddOnMicros > 0 && (
                <div className="mt-1 flex justify-between text-sm">
                  <span className="text-muted-foreground">Storage add-on ({storageGb}GB)</span>
                  <span className="font-mono-data">{formatGbp(price!.storageAddOnMicros)}/hr</span>
                </div>
              )}
              <div className="mt-2 flex justify-between border-t border-border pt-2 text-sm font-medium">
                <span>Total</span>
                <span className="font-mono-data">{formatGbp(price!.totalHourlyMicros)}/hour</span>
              </div>
              {hoursLeft !== null && (
                <p className="mt-2 text-xs text-muted-foreground">
                  At this rate, your wallet balance of {formatGbp(walletBalanceMicros)} covers approximately{" "}
                  {hoursLeft < 1 ? "under an hour" : `${hoursLeft.toFixed(1)} hours`}.
                </p>
              )}
            </>
          ) : (
            <>
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">
                  {formatGbp(price!.totalHourlyMicros)}/hr × {duration === "day" ? "24 hours" : "168 hours"}
                </span>
                <span className="font-mono-data">{formatGbp(bookingTotal)}</span>
              </div>
              <div className="mt-2 flex justify-between border-t border-border pt-2 text-sm font-medium">
                <span>Total charge today</span>
                <span className="font-mono-data">{formatGbp(bookingTotal)}</span>
              </div>
            </>
          )}
        </div>

        {atConcurrentLimit && (
          <p className="flex items-center gap-1.5 text-sm text-warning">
            <AlertTriangle className="h-3.5 w-3.5" />
            You're at your plan's concurrent rental limit. Stop or terminate a rental, or upgrade your plan.
          </p>
        )}
        {mode === "pay_as_you_go" && insufficientBalance && !atConcurrentLimit && (
          <p className="flex items-center gap-1.5 text-sm text-warning">
            <AlertTriangle className="h-3.5 w-3.5" />
            Your wallet balance won't cover even an hour at this rate — top up above to continue.
          </p>
        )}

        <Button
          className="w-full"
          size="lg"
          loading={pending}
          disabled={noSshKeys || atConcurrentLimit || (mode === "pay_as_you_go" && insufficientBalance)}
          onClick={handleSubmit}
        >
          {mode === "pay_as_you_go" ? "Rent now" : `Book & pay ${formatGbp(bookingTotal)}`}
        </Button>
      </CardContent>
    </Card>
  );
}
