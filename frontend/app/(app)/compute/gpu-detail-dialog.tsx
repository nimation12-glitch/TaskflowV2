"use client";

import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Check, Clock, Cpu, Globe, HardDrive, Layers, MapPin } from "lucide-react";
import { formatGbp } from "@/lib/utils";
import { fromPremiumMicros, priceBreakdown } from "@/lib/gpu-pricing";
import {
  PLAN_LIMITS,
  REGION_AREAS,
  REGION_NAMES,
  STORAGE_OPTIONS,
  type GpuSku,
  type PlanCode,
} from "@/lib/compute-types";

// Detail view behind a catalogue card: the SKU's configurations, its price in
// EVERY launch region (offered rows priced, N/A rows marked), and the machine
// image each region boots. Data comes from GET /compute/gpu-types — no price
// is ever computed client-side beyond the documented §24 decomposition.

type RegionRow = {
  code: string;
  name: string;
  area: string;
  offered: boolean;
  totalMicros: number;
  premiumMicros: number;
  startupSeconds: number | null;
  amiId: string | null;
};

export function GpuDetailDialog({
  sku,
  plan,
  familySkus,
  open,
  onOpenChange,
  onSelect,
}: {
  sku: GpuSku;
  plan: PlanCode;
  /** Other SKUs of the same GPU family — switchable configurations. */
  familySkus: GpuSku[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Inspect another configuration of the same family. */
  onSelect: (slug: string) => void;
}) {
  const limits = PLAN_LIMITS[plan];
  const fromPrice = priceBreakdown(sku, 0, plan, fromPremiumMicros(sku)).totalHourlyMicros;

  const offeredByCode = new Map(sku.regions.offered.map((r) => [r.code, r]));
  const notOffered = new Set(sku.regions.not_offered);
  const allCodes = [
    ...new Set([...Object.keys(REGION_NAMES), ...offeredByCode.keys(), ...notOffered]),
  ];

  // Every region: offered rows priced via §24 (base + premium), everything
  // else explicitly marked unavailable for this configuration.
  const rows: RegionRow[] = allCodes
    .map((code): RegionRow => {
      const offered = offeredByCode.get(code);
      if (!offered) {
        return {
          code,
          name: REGION_NAMES[code] ?? code,
          area: REGION_AREAS[code] ?? "",
          offered: false,
          totalMicros: 0,
          premiumMicros: 0,
          startupSeconds: null,
          amiId: null,
        };
      }
      return {
        code,
        name: offered.name ?? REGION_NAMES[code] ?? code,
        area: offered.area,
        offered: true,
        totalMicros: priceBreakdown(sku, 0, plan, offered.premium_micros).totalHourlyMicros,
        premiumMicros: offered.premium_micros,
        startupSeconds: offered.startup_estimate_seconds,
        amiId: offered.ami_id ?? null,
      };
    })
    .sort((a, b) => {
      if (a.offered !== b.offered) return a.offered ? -1 : 1;
      if (a.offered && b.offered) return a.totalMicros - b.totalMicros || a.name.localeCompare(b.name);
      return a.name.localeCompare(b.name);
    });

  const offeredCount = rows.filter((r) => r.offered).length;
  const siblings = familySkus.filter((s) => s.slug !== sku.slug);

  const specs: { label: string; value: string }[] = [
    { label: "GPUs", value: `${sku.gpu_count}× ${sku.gpu.replace("NVIDIA ", "")}` },
    { label: "VRAM", value: `${sku.vram_gb} GB` },
    { label: "vCPU", value: String(sku.vcpu) },
    { label: "RAM", value: `${sku.ram_gb} GB` },
    { label: "Min rental", value: `${sku.minimum_rental_hours} hour${sku.minimum_rental_hours === 1 ? "" : "s"}` },
    { label: "Tier", value: sku.tier },
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2">
            {sku.display_name}
            {sku.tier === "ULTRA" && <Badge variant="default">Ultra</Badge>}
            <Badge variant="success">Available now</Badge>
          </DialogTitle>
          <DialogDescription>
            {sku.gpu_count}× {sku.gpu} · {sku.vram_gb}GB VRAM · {sku.vcpu} vCPU · {sku.ram_gb}GB RAM
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[60vh] space-y-5 overflow-y-auto pr-1">
          {/* ------------- Configurations ------------- */}
          <section>
            <h3 className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              <Layers className="h-3.5 w-3.5" />
              Configurations
            </h3>

            <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
              {specs.map((s) => (
                <div key={s.label} className="rounded-md border border-border bg-muted/30 px-2 py-1.5 text-center">
                  <p className="font-mono-data text-sm font-semibold">{s.value}</p>
                  <p className="text-[10px] text-muted-foreground">{s.label}</p>
                </div>
              ))}
            </div>

            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <div>
                <p className="mb-1.5 text-[11px] font-medium text-muted-foreground">Storage per rental</p>
                <div className="flex flex-wrap gap-1.5">
                  {STORAGE_OPTIONS.map((opt) => {
                    const allowed = opt.gb <= limits.maxStorageGb;
                    return (
                      <Badge key={opt.gb} variant={allowed ? "secondary" : "outline"} className={allowed ? "" : "opacity-60"}>
                        {opt.gb} GB
                        {!allowed && " · higher plan"}
                      </Badge>
                    );
                  })}
                </div>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  First 100 GB included in the base rate; extra storage adds £0.03/hr per 100 GB block.
                </p>
              </div>
              <div>
                <p className="mb-1.5 text-[11px] font-medium text-muted-foreground">Ordering</p>
                <div className="flex flex-wrap gap-1.5">
                  <Badge variant="secondary">1–10 GPUs / order</Badge>
                  <Badge variant="secondary">Pay as you go</Badge>
                  {sku.booking_allowed && limits.bookingAllowed ? (
                    <Badge variant="secondary">Booking · day / week</Badge>
                  ) : (
                    <Badge variant="outline">Booking · higher plan</Badge>
                  )}
                </div>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  Your {plan} plan allows {limits.concurrentRentals} concurrent GPU
                  {limits.concurrentRentals === 1 ? "" : "s"} · storage up to {limits.maxStorageGb} GB per GPU. Every
                  GPU in an order shares storage, region and workspace.
                </p>
              </div>
            </div>

            {siblings.length > 0 && (
              <div className="mt-3">
                <p className="mb-1.5 text-[11px] font-medium text-muted-foreground">Other configurations in {sku.gpu}</p>
                <div className="flex flex-wrap gap-1.5">
                  {siblings.map((s) => (
                    <button
                      key={s.slug}
                      onClick={() => onSelect(s.slug)}
                      className="rounded-md border border-border px-2.5 py-1 text-xs transition-colors hover:bg-muted/30"
                    >
                      {s.display_name}
                      <span className="ml-1.5 font-mono-data text-muted-foreground">
                        {formatGbp(priceBreakdown(s, 0, plan, fromPremiumMicros(s)).totalHourlyMicros)}/hr
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </section>

          {/* ------------- Price per region ------------- */}
          <section>
            <h3 className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              <Globe className="h-3.5 w-3.5" />
              Price per region · {offeredCount} of {rows.length} regions offered
            </h3>
            <div className="overflow-hidden rounded-md border border-border">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border bg-muted/40 text-left text-muted-foreground">
                    <th className="px-3 py-2 font-medium">Region</th>
                    <th className="px-3 py-2 text-right font-medium">Price</th>
                    <th className="px-3 py-2 text-right font-medium">Premium</th>
                    <th className="px-3 py-2 text-right font-medium">Ready in</th>
                    <th className="px-3 py-2 text-right font-medium">Machine image</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.code} className={r.offered ? "" : "text-muted-foreground opacity-70"}>
                      <td className="px-3 py-2">
                        <span className="flex items-center gap-1.5">
                          <MapPin className="h-3 w-3 shrink-0" />
                          <span>
                            <span className="block font-medium text-foreground">{r.name}</span>
                            <span className="block text-[10px]">{r.area || r.code}</span>
                          </span>
                        </span>
                      </td>
                      {r.offered ? (
                        <>
                          <td className="px-3 py-2 text-right font-mono-data font-semibold">
                            {formatGbp(r.totalMicros)}/hr
                          </td>
                          <td className="px-3 py-2 text-right font-mono-data">
                            {r.premiumMicros > 0 ? `+${formatGbp(r.premiumMicros)}` : "—"}
                          </td>
                          <td className="px-3 py-2 text-right">
                            {r.startupSeconds !== null ? (
                              <span className="inline-flex items-center gap-1">
                                <Clock className="h-3 w-3" />
                                ~{Math.max(1, Math.round(r.startupSeconds / 60))} min
                              </span>
                            ) : (
                              "—"
                            )}
                          </td>
                          <td className="px-3 py-2 text-right">
                            {r.amiId ? (
                              <span className="font-mono-data">{r.amiId}</span>
                            ) : (
                              <span className="inline-flex items-center gap-1">
                                <HardDrive className="h-3 w-3" />
                                resolves at launch
                              </span>
                            )}
                          </td>
                        </>
                      ) : (
                        <td className="px-3 py-2 text-right" colSpan={4}>
                          Not offered for this configuration
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-1.5 text-[11px] text-muted-foreground">
              Price = fixed base rate + regional service premium (never discounted by your plan). Automatic launch picks
              the cheapest region shown here.
            </p>
          </section>

          {/* ------------- Machine image ------------- */}
          {sku.image && (
            <section>
              <h3 className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                <HardDrive className="h-3.5 w-3.5" />
                Machine image
              </h3>
              <div className="rounded-md border border-border bg-muted/30 p-3">
                <p className="flex items-center gap-2 text-sm font-medium">
                  <Check className="h-4 w-4 text-success" />
                  {sku.image.name}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Preinstalled with NVIDIA drivers and PyTorch. The image id is resolved per region from public SSM
                  parameter <span className="font-mono-data break-all">{sku.image.ssm_parameter}</span> at launch, so
                  each region always boots its own compatible AMI.
                </p>
              </div>
            </section>
          )}
        </div>

        <DialogFooter className="items-center">
          <span className="mr-auto text-xs text-muted-foreground">
            <Cpu className="mr-1 inline h-3.5 w-3.5" />
            from <span className="font-mono-data font-semibold text-foreground">{formatGbp(fromPrice)}/hr</span>
          </span>
          <span className="hidden text-xs text-muted-foreground sm:inline">Chosen in workspace setup</span>
          <Link href="/compute?tab=workspaces">
            <Button>Rent this GPU</Button>
          </Link>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
