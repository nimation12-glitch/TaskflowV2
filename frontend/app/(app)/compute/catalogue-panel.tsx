"use client";

import { useMemo, useState } from "react";
import { Cpu, Globe, Image, Info, Tag } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatGbp } from "@/lib/utils";
import { fromPremiumMicros, priceBreakdown } from "@/lib/gpu-pricing";
import { PLAN_LIMITS, type GpuSku, type ImageCatalogueEntry, type PlanCode } from "@/lib/compute-types";
import { groupFamilies } from "./gpu-picker";
import { GpuDetailDialog } from "./gpu-detail-dialog";

// Browse-only catalogue: GPU FAMILIES (family name + from-price, every
// configuration inside) and the machine-image catalogue. Nothing is launched
// from here — the GPU is chosen in workspace setup, which boots the machine
// on AWS and starts billing.

export function CataloguePanel({
  gpuTypes,
  images,
  plan,
}: {
  gpuTypes: GpuSku[];
  images: ImageCatalogueEntry[];
  plan: PlanCode;
}) {
  const [detailSlug, setDetailSlug] = useState<string | null>(null);
  const limits = PLAN_LIMITS[plan];

  // Group the catalogue by GPU family (e.g. NVIDIA T4), cheapest first.
  const families = useMemo(() => groupFamilies(gpuTypes), [gpuTypes]);
  const detailSku = detailSlug ? (gpuTypes.find((t) => t.slug === detailSlug) ?? null) : null;

  if (gpuTypes.length === 0) {
    return (
      <Card>
        <CardContent className="pt-6 text-sm text-muted-foreground">
          The GPU catalogue isn&apos;t reachable right now — check back shortly.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      {/* ---------------- GPU families ---------------- */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-foreground">
            <Cpu className="h-4 w-4" />
            GPU families
          </CardTitle>
          <CardDescription>
            Every configuration below is rentable now · {limits.concurrentRentals} concurrent GPU
            {limits.concurrentRentals === 1 ? "" : "s"} on your {plan} plan · billed by the hour from your wallet ·
            pick a family to see its configurations and regional prices
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {families.map((family) => {
              const fromPrice = Math.min(
                ...family.skus.map((s) => priceBreakdown(s, 0, plan, fromPremiumMicros(s)).totalHourlyMicros)
              );
              const regionCount = new Set(family.skus.flatMap((s) => s.regions.offered.map((r) => r.code))).size;
              const isUltra = family.skus.every((s) => s.tier === "ULTRA");
              return (
                <button
                  key={family.label}
                  onClick={() => setDetailSlug(family.skus[0].slug)}
                  className="rounded-md border border-border p-3 text-left transition-colors hover:bg-muted/30"
                >
                  <span className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium">{family.label}</span>
                    {isUltra && <Badge variant="default">Ultra</Badge>}
                  </span>
                  <span className="mt-1 block font-mono-data text-lg font-semibold">
                    {formatGbp(fromPrice)}
                    <span className="ml-1 text-xs font-normal text-muted-foreground">/hr from</span>
                  </span>
                  <span className="mt-1 block text-xs text-muted-foreground">
                    {family.skus.length} configuration{family.skus.length === 1 ? "" : "s"} ·{" "}
                    {family.skus.map((s) => s.gpu_count).join("/")}× GPU options · {regionCount} region
                    {regionCount === 1 ? "" : "s"}
                  </span>
                  <span className="mt-2 flex items-center gap-1 text-[11px] text-muted-foreground">
                    <Globe className="h-3 w-3" />
                    Configurations, specs &amp; price per region
                  </span>
                </button>
              );
            })}
          </div>
          <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            Prices are the fixed base rate at the cheapest available region. GPUs are rented from a workspace — create
            one on the Workspaces tab, choose its GPU there, and it boots on AWS the moment you confirm.
          </p>
        </CardContent>
      </Card>

      {/* ---------------- Machine images ---------------- */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-foreground">
            <Image className="h-4 w-4" />
            Machine images
          </CardTitle>
          <CardDescription>
            The environment a workspace boots with — chosen once in workspace setup and reused on every GPU start ·
            free on AWS means free here
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {images.length === 0 && (
            <p className="text-sm text-muted-foreground">
              The image catalogue isn&apos;t reachable right now — workspaces still boot the platform default image.
            </p>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            {images.map((img) => (
              <div key={img.slug} className="rounded-md border border-border bg-muted/20 p-3">
                <div className="flex items-start justify-between gap-2">
                  <p className="text-sm font-medium">{img.display_name}</p>
                  <span className="flex shrink-0 gap-1.5">
                    {img.is_default && <Badge variant="secondary">Default</Badge>}
                    <Badge variant={img.is_free ? "success" : "warning"}>
                      {img.is_free ? "Free" : `${formatGbp(img.hourly_price_micros)}/hr`}
                    </Badge>
                  </span>
                </div>
                {img.description && <p className="mt-1 text-xs text-muted-foreground">{img.description}</p>}
                <p className="mt-2 flex items-center gap-1 text-[11px] text-muted-foreground">
                  <Tag className="h-3 w-3" />
                  {img.is_free ? "No extra charge — the GPU is the only billed part" : `Adds ${formatGbp(img.hourly_price_micros)}/hr`}
                </p>
              </div>
            ))}
          </div>
          <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            Images never launch on their own — a workspace carries one and the platform resolves the right regional AMI
            each time it boots.
          </p>
        </CardContent>
      </Card>

      {/* GPU detail: configurations, price per region, machine image */}
      {detailSku && (
        <GpuDetailDialog
          sku={detailSku}
          plan={plan}
          familySkus={gpuTypes.filter((t) => t.gpu === detailSku.gpu)}
          open
          onOpenChange={(next) => {
            if (!next) setDetailSlug(null);
          }}
          onSelect={(slug) => setDetailSlug(slug)}
        />
      )}
    </div>
  );
}
