"use client";

/** Compute — GPU catalog preview (Phase 9). Rental lifecycle is gated OFF; honest "coming soon". */

import { useEffect, useState } from "react";
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/client-api";
import { formatGBP } from "@/lib/money";
import type { MeResponse } from "@/types/taskflow";
import { Cpu, Clock, ShieldCheck, ArrowRight } from "lucide-react";
import { PlanBadge } from "./dashboard-shell";

type GpuCatalogRow = {
  id: string;
  displayName: string;
  vramGb: number;
  hourlyRateMicros: number;
  description: string;
  isActive: boolean;
};

// Catalog is served by the models API surface in future; for now read from a small
// dedicated endpoint. Fallback list keeps the page honest if API is unavailable.
const FALLBACK: GpuCatalogRow[] = [];

export function ComputeView({ me }: { me: MeResponse }) {
  const [gpus, setGpus] = useState<GpuCatalogRow[] | null>(null);

  useEffect(() => {
    api<{ gpus: GpuCatalogRow[] }>("/api/compute/gpus")
      .then((d) => setGpus(d.gpus))
      .catch(() => setGpus(FALLBACK));
  }, []);

  const canRent = me.subscription?.canRentGpu ?? false;

  return (
    <div className="space-y-5">
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
        <div>
          <h2 className="text-xl font-bold tracking-tight text-slate-900">Compute</h2>
          <p className="text-sm text-slate-500">Dedicated GPU rental &amp; managed model deployments</p>
        </div>
        <PlanBadge planId={me.subscription?.planId ?? "free"} />
      </div>

      {/* Coming soon banner */}
      <Card className="border-emerald-200 bg-gradient-to-br from-emerald-50/60 to-white">
        <CardHeader className="pb-2">
          <div className="flex items-center gap-2">
            <Cpu className="h-5 w-5 text-emerald-600" />
            <CardTitle className="text-base">GPU rental is coming soon</CardTitle>
            <Badge variant="outline" className="border-emerald-300 bg-emerald-100 text-emerald-700">Phase 9</Badge>
          </div>
          <CardDescription>
            The core platform (gateway, metering, credits, subscriptions) ships first — exactly per the
            TaskFlow roadmap. GPU rental follows once the foundation is stable.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 text-sm text-slate-600 sm:grid-cols-3">
            <div className="flex items-start gap-2">
              <Clock className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
              <span>Billed per second of runtime with configurable auto-shutdown when idle — no idle burn.</span>
            </div>
            <div className="flex items-start gap-2">
              <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
              <span>Managed endpoints with TaskFlow auth, rate limiting and usage metering built in.</span>
            </div>
            <div className="flex items-start gap-2">
              <ArrowRight className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
              <span>Rent a GPU, deploy your model, get an API — like the shared gateway, but dedicated.</span>
            </div>
          </div>
          {!canRent && (
            <p className="mt-3 text-xs text-amber-600">
              Your current plan does not include GPU rental — upgrading to Pro or Max will unlock it when launched.
            </p>
          )}
        </CardContent>
      </Card>

      {/* Catalog */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Planned GPU catalog</CardTitle>
          <CardDescription>
            Example hourly pricing — final rates are configurable and may change before launch.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {gpus === null ? (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-28 w-full" />)}
            </div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {gpus.map((g) => (
                <div key={g.id} className="rounded-xl border border-slate-200 bg-white p-4">
                  <div className="flex items-start justify-between gap-2">
                    <div className="font-semibold text-slate-900">{g.displayName}</div>
                    <Badge variant="outline" className="border-slate-200 text-slate-500">{g.vramGb} GB</Badge>
                  </div>
                  <p className="mt-1.5 text-xs leading-relaxed text-slate-500">{g.description}</p>
                  <div className="mt-3 flex items-baseline justify-between">
                    <span className="text-lg font-bold text-slate-900">
                      {formatGBP(g.hourlyRateMicros)}
                      <span className="text-xs font-normal text-slate-400">/hour</span>
                    </span>
                    <span className="text-[11px] text-slate-400">≈ {formatGBP(Math.round(g.hourlyRateMicros / 3600), { force4dp: true })}/min</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
