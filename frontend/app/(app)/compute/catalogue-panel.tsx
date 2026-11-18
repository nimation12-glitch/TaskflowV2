"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Cpu, KeyRound, AlertTriangle, Info, Globe, MapPin, Clock, HardDrive } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { useAction } from "@/lib/hooks/use-action";
import { formatGbp } from "@/lib/utils";
import {
  priceBreakdown,
  fromPremiumMicros,
  premiumForPreference,
  bookingTotalMicros,
  estimatedHoursRemaining,
  reserveHoursFor,
} from "@/lib/gpu-pricing";
import {
  PLAN_LIMITS,
  STORAGE_OPTIONS,
  LOCATION_OPTIONS,
  REGION_NAMES,
  type GpuSku,
  type LocationPreference,
  type PlanCode,
  type SshKey,
} from "@/lib/compute-types";
import { createRentalAction } from "./actions";

type WorkspaceSummary = { id: string; name: string; storage_size_gb: number; ssh_key_id: string | null; ssh_key_label: string | null };

export function CataloguePanel({
  gpuTypes,
  sshKeys,
  workspaces,
  plan,
  walletBalanceMicros,
  concurrentUsed,
}: {
  gpuTypes: GpuSku[];
  sshKeys: SshKey[];
  workspaces: WorkspaceSummary[];
  plan: PlanCode;
  walletBalanceMicros: number;
  concurrentUsed: number;
}) {
  const limits = PLAN_LIMITS[plan];
  const enabledSku = gpuTypes.find((t) => t.enabled);
  const [skuSlug, setSkuSlug] = useState(gpuTypes[0]?.slug);
  const [storageGb, setStorageGb] = useState(50);
  const [location, setLocation] = useState<LocationPreference>("automatic");
  const [sshKeyId, setSshKeyId] = useState(""); // "" = inherit the attached workspace's key
  const [workspaceId, setWorkspaceId] = useState("");
  const [mode, setMode] = useState<"pay_as_you_go" | "booking">("pay_as_you_go");
  const [duration, setDuration] = useState<"day" | "week">("day");
  const [quantity, setQuantity] = useState(1);
  const { pending, run } = useAction();

  const sku = gpuTypes.find((t) => t.slug === skuSlug) ?? gpuTypes[0];

  // Group the catalogue by GPU family (e.g. NVIDIA T4), cheapest first.
  const families = useMemo(() => {
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
  }, [gpuTypes]);

  const workspace = workspaces.find((w) => w.id === workspaceId) ?? null;
  const workspaceKey = workspace?.ssh_key_label ? workspace : null;

  const pref = useMemo(
    () => (sku ? premiumForPreference(sku, location) : { available: false, premiumMicros: 0, regionCode: null, startupSeconds: null }),
    [sku, location]
  );
  const price = useMemo(
    () => (sku ? priceBreakdown(sku, storageGb, plan, pref.premiumMicros) : null),
    [sku, storageGb, plan, pref]
  );
  // Multi-GPU: N identical copies of the selected SKU rent as one order.
  // The picker can never exceed the plan's remaining concurrent slots or
  // the platform cap of 10 GPUs per order.
  const remainingSlots = Math.max(0, limits.concurrentRentals - concurrentUsed);
  const maxQuantity = Math.max(1, Math.min(10, remainingSlots));
  const gpuCount = Math.min(quantity, maxQuantity);
  const hourlyTotal = price ? price.totalHourlyMicros * gpuCount : 0;
  const bookingTotal = price ? bookingTotalMicros(price.totalHourlyMicros, duration) * gpuCount : 0;
  const hoursLeft = price ? estimatedHoursRemaining(walletBalanceMicros, hourlyTotal) : null;
  const reserveHours = sku ? reserveHoursFor(sku) : 1;
  const reserveNeeded = price ? price.totalHourlyMicros * reserveHours * gpuCount : 0;
  // PAYG needs wallet cover for the §20 reserve (× the whole order) before
  // launch; bookings are paid through Stripe checkout instead, so the wallet
  // isn't involved.
  const insufficientBalance =
    price && mode === "pay_as_you_go" ? walletBalanceMicros < reserveNeeded : false;

  const atConcurrentLimit = concurrentUsed >= limits.concurrentRentals;
  const noSshOption = sshKeys.length === 0 && !workspaceKey;
  const bookingBlocked = mode === "booking" && !limits.bookingAllowed;
  const launchBlockedReason = !sku
    ? null
    : !sku.enabled
      ? "This GPU isn't rentable yet — it's coming soon."
      : !pref.available
        ? "Not offered in the selected location — try another location or Automatic."
        : bookingBlocked
          ? "Upgrade to Pro to book a GPU for a fixed period."
          : noSshOption
            ? "Add an SSH key (or attach a workspace that has one) to launch."
            : atConcurrentLimit
              ? "You're at your plan's concurrent rental limit."
              : insufficientBalance
                ? "Your wallet balance doesn't cover the required reserve at this rate."
                : null;

  function handleSubmit() {
    if (!sku || launchBlockedReason || !price) return;
    run(
      () =>
        createRentalAction({
          gpu_type_slug: sku.slug,
          storage_gb: storageGb,
          ...(sshKeyId ? { ssh_key_id: sshKeyId } : {}),
          ...(workspaceId ? { workspace_id: workspaceId } : {}),
          payment_mode: mode,
          location_preference: location,
          quantity: gpuCount,
          ...(mode === "booking" ? { booking_duration: duration } : {}),
        }),
      {
        success:
          gpuCount > 1
            ? `Starting ${gpuCount} × ${sku.display_name}…`
            : mode === "pay_as_you_go"
              ? "GPU rental starting…"
              : "Redirecting to checkout…",
        error: "Couldn't start the rental",
      }
    );
  }

  if (!sku) {
    return (
      <Card>
        <CardContent className="pt-6 text-sm text-muted-foreground">
          The GPU catalogue isn't reachable right now — check back shortly.
        </CardContent>
      </Card>
    );
  }

  const tierBadge = sku.tier === "ULTRA" ? "default" : "outline";

  return (
    <div className="space-y-6">
      {/* ---------------- Catalogue ---------------- */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-foreground">
            <Cpu className="h-4 w-4" />
            GPU catalogue
          </CardTitle>
          <CardDescription>
            {concurrentUsed}/{limits.concurrentRentals} concurrent rentals used · {limits.queuePriority} queue priority ·
            fixed list prices, billed from your wallet
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {families.map((family) => (
            <div key={family.label}>
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">{family.label}</p>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                {family.skus.map((t) => {
                  const fromPremium = fromPremiumMicros(t);
                  const fromPrice = priceBreakdown(t, 0, plan, fromPremium).totalHourlyMicros;
                  const selected = t.slug === skuSlug;
                  return (
                    <button
                      key={t.slug}
                      onClick={() => setSkuSlug(t.slug)}
                      className={`rounded-md border p-3 text-left transition-colors ${
                        selected ? "border-primary bg-primary/10" : "border-border hover:bg-muted/30"
                      } ${!t.enabled ? "opacity-70" : ""}`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-sm font-medium">{t.display_name}</p>
                        {!t.enabled ? (
                          <Badge variant="outline">Coming soon</Badge>
                        ) : t.tier === "ULTRA" ? (
                          <Badge variant={tierBadge}>Ultra</Badge>
                        ) : null}
                      </div>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {t.gpu_count}× {t.gpu.replace("NVIDIA ", "")} · {t.vram_gb}GB VRAM
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {t.vcpu} vCPU · {t.ram_gb}GB RAM
                      </p>
                      <p className="mt-2 font-mono-data text-sm font-semibold">
                        {formatGbp(fromPrice)}/hr
                        <span className="ml-1 text-[11px] font-normal text-muted-foreground">from</span>
                      </p>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
          <p className="text-xs text-muted-foreground">
            Prices are the fixed base rate at the cheapest available region; the exact regional premium is shown below
            before you pay.
          </p>
        </CardContent>
      </Card>

      {/* ---------------- Launch configuration ---------------- */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-foreground">
            <HardDrive className="h-4 w-4" />
            Launch {sku.display_name}
          </CardTitle>
          <CardDescription>
            {sku.gpu} · {sku.gpu_count}× GPU ({sku.vram_gb}GB VRAM) · {sku.vcpu} vCPU · {sku.ram_gb}GB RAM
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Storage */}
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
                        Needs a higher plan
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Region */}
          <div>
            <div className="mb-2 flex items-center gap-1.5">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Region</p>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button type="button" className="text-muted-foreground hover:text-foreground">
                    <Info className="h-3.5 w-3.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent className="max-w-xs">
                  You pick the GPU — we automatically launch it in the best region for capacity and startup time. Choose
                  a location only if your data must stay close by.
                </TooltipContent>
              </Tooltip>
            </div>
            <select
              value={location}
              onChange={(e) => setLocation(e.target.value as LocationPreference)}
              className="h-10 w-full rounded-md border border-border bg-muted/40 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
            >
              {LOCATION_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            {pref.available ? (
              <p className="mt-1.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                <MapPin className="h-3.5 w-3.5" />
                {location === "automatic" ? "Region: automatically selected" : `Region: ${REGION_NAMES[pref.regionCode ?? ""] ?? pref.regionCode}`}
                {pref.startupSeconds !== null && (
                  <span className="inline-flex items-center gap-1">
                    <Clock className="h-3.5 w-3.5" />
                    usually ready in ~{Math.max(1, Math.round(pref.startupSeconds / 60))} min
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

          {/* Quantity — rent several identical GPUs in one order */}
          <div>
            <div className="mb-2 flex items-center gap-1.5">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">GPUs</p>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button type="button" className="text-muted-foreground hover:text-foreground">
                    <Info className="h-3.5 w-3.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent className="max-w-xs">
                  Rent several identical GPUs in one order — every GPU gets the same storage, region and rate, and can
                  share the same workspace and SSH key.
                </TooltipContent>
              </Tooltip>
            </div>
            <div className="inline-flex items-center gap-1 rounded-md border border-border bg-muted/30 p-1">
              <button
                type="button"
                onClick={() => setQuantity(Math.max(1, gpuCount - 1))}
                disabled={gpuCount <= 1}
                className="rounded-sm px-3 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 hover:bg-card"
                aria-label="Fewer GPUs"
              >
                −
              </button>
              <span className="min-w-28 px-2 text-center text-sm font-medium">
                {gpuCount} × {sku.display_name}
              </span>
              <button
                type="button"
                onClick={() => setQuantity(Math.min(maxQuantity, gpuCount + 1))}
                disabled={gpuCount >= maxQuantity}
                className="rounded-sm px-3 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 hover:bg-card"
                aria-label="More GPUs"
              >
                +
              </button>
            </div>
            <p className="mt-1.5 text-[11px] text-muted-foreground">
              Up to {maxQuantity} identical GPU{maxQuantity === 1 ? "" : "s"} per order on your plan
              {remainingSlots > 0 && gpuCount < 10
                ? ` — ${remainingSlots} concurrent rental slot${remainingSlots === 1 ? "" : "s"} free`
                : ""}
              . Each GPU is billed at the same rate.
            </p>
          </div>

          {/* SSH key + workspace */}
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">SSH key</p>
              {sshKeys.length === 0 && !workspaceKey ? (
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
                  {workspaceKey && <option value="">Workspace key ({workspaceKey.ssh_key_label})</option>}
                  {sshKeys.map((k) => (
                    <option key={k.id} value={k.id}>
                      {k.label} ({k.fingerprint})
                    </option>
                  ))}
                </select>
              )}
            </div>
            <div>
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Attach workspace (optional)</p>
              <select
                value={workspaceId}
                onChange={(e) => setWorkspaceId(e.target.value)}
                className="h-10 w-full rounded-md border border-border bg-muted/40 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
              >
                <option value="">None — standalone rental</option>
                {workspaces.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name} ({w.storage_size_gb}GB)
                  </option>
                ))}
              </select>
              <p className="mt-1.5 text-[11px] text-muted-foreground">
                A workspace keeps its storage and SSH identity between rentals. Every GPU in the order attaches to it.
                Manage them on the Workspaces tab.
              </p>
            </div>
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
                onClick={() => limits.bookingAllowed && sku.booking_allowed && setMode("booking")}
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
                  <span className="text-muted-foreground">Base rate ({sku.display_name})</span>
                  <span className="font-mono-data">{formatGbp(price!.discountedBaseRateMicros)}/hr</span>
                </div>
                {price!.premiumMicros > 0 && (
                  <div className="mt-1 flex justify-between text-sm">
                    <span className="flex items-center gap-1 text-muted-foreground">
                      <Globe className="h-3.5 w-3.5" />
                      Regional premium ({REGION_NAMES[pref.regionCode ?? ""] ?? "selected region"})
                    </span>
                    <span className="font-mono-data">{formatGbp(price!.premiumMicros)}/hr</span>
                  </div>
                )}
                {price!.storageAddOnMicros > 0 && (
                  <div className="mt-1 flex justify-between text-sm">
                    <span className="text-muted-foreground">Storage add-on ({storageGb}GB)</span>
                    <span className="font-mono-data">{formatGbp(price!.storageAddOnMicros)}/hr</span>
                  </div>
                )}
                <div className="mt-2 flex justify-between text-sm">
                  <span className="text-muted-foreground">Quantity</span>
                  <span className="font-mono-data">× {gpuCount} GPU{gpuCount === 1 ? "" : "s"}</span>
                </div>
                <div className="mt-2 flex justify-between border-t border-border pt-2 text-sm font-medium">
                  <span>Total</span>
                  <span className="font-mono-data">{formatGbp(hourlyTotal)}/hour</span>
                </div>
                {hoursLeft !== null && (
                  <p className="mt-2 text-xs text-muted-foreground">
                    At this rate, your wallet balance of {formatGbp(walletBalanceMicros)} covers approximately{" "}
                    {hoursLeft < 1 ? "under an hour" : `${hoursLeft.toFixed(1)} hours`}. Launches reserve at least{" "}
                    {reserveHours} hour{reserveHours > 1 ? "s" : ""} of cover ({formatGbp(reserveNeeded)}).
                  </p>
                )}
              </>
            ) : (
              <>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">
                    {formatGbp(price!.totalHourlyMicros)}/hr × {duration === "day" ? "24 hours" : "168 hours"}
                    {gpuCount > 1 ? ` × ${gpuCount} GPUs` : ""}
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

          {launchBlockedReason && (
            <p className="flex items-center gap-1.5 text-sm text-warning">
              <AlertTriangle className="h-3.5 w-3.5" />
              {launchBlockedReason}
            </p>
          )}

          <Button
            className="w-full"
            size="lg"
            loading={pending}
            disabled={!!launchBlockedReason}
            onClick={handleSubmit}
          >
            {mode === "pay_as_you_go"
              ? `Rent ${gpuCount > 1 ? `${gpuCount} × ` : ""}${sku.display_name} · ${formatGbp(hourlyTotal)}/hr`
              : `Book ${gpuCount > 1 ? `${gpuCount} × ` : ""}${sku.display_name} · pay ${formatGbp(bookingTotal)}`}
          </Button>
          {!sku.enabled && (
            <p className="text-xs text-muted-foreground">
              This configuration is in the catalogue but not rentable yet — capacity and regional images are still being
              brought online.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
