"use client";

/** Models — catalog for the customer's plan with tier gating (backend remains authoritative). */

import { useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/client-api";
import { formatGBP } from "@/lib/money";
import type { ModelsResponse, ModelRow } from "@/types/taskflow";
import type { DashboardView } from "./dashboard-shell";
import { toast } from "@/hooks/use-toast";
import { Boxes, Lock, Sparkles, CheckCircle2 } from "lucide-react";

const TIER_STYLES: Record<string, string> = {
  FREE: "border-slate-300 bg-slate-100 text-slate-600",
  PRO: "border-emerald-300 bg-emerald-100 text-emerald-700",
  MAX: "border-amber-300 bg-amber-100 text-amber-700",
};

// Effective status badges (MASTER_PROJECT_CONTEXT §50) — the Models page must
// show exactly what can be served: LIVE, COMING SOON, NOT CONFIGURED, etc.
const STATUS_LABELS: Record<string, string> = {
  LIVE: "LIVE",
  COMING_SOON: "COMING SOON",
  NOT_CONFIGURED: "NOT CONFIGURED",
  DISABLED: "DISABLED",
  DEMO_ONLY: "DEMO ONLY",
};

const STATUS_STYLES: Record<string, string> = {
  LIVE: "border-emerald-300 bg-emerald-50 text-emerald-700",
  COMING_SOON: "border-slate-300 bg-slate-100 text-slate-500",
  NOT_CONFIGURED: "border-amber-300 bg-amber-50 text-amber-700",
  DISABLED: "border-red-200 bg-red-50 text-red-600",
  DEMO_ONLY: "border-violet-200 bg-violet-50 text-violet-700",
};

const HOSTING_LABELS: Record<string, string> = {
  EXTERNAL_API: "External provider API",
  TASKFLOW_HOSTED: "TaskFlow-managed inference",
  CUSTOMER_HOSTED: "Customer-hosted artifact",
};

function capLabel(c: string): string {
  const map: Record<string, string> = {
    chat: "Chat", reasoning: "Reasoning", vision: "Vision", "long-context": "Long context",
  };
  return map[c] ?? c;
}

export function ModelsView({ onNavigate }: { onNavigate: (v: DashboardView) => void }) {
  const [data, setData] = useState<ModelsResponse | null>(null);

  useEffect(() => {
    let alive = true;
    api<ModelsResponse>("/api/models")
      .then((d) => {
        if (alive) setData(d);
      })
      .catch(() => toast({ title: "Could not load models", variant: "destructive" }));
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className="space-y-5">
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
        <div>
          <h2 className="text-xl font-bold tracking-tight text-slate-900">Models</h2>
          <p className="text-sm text-slate-500">
            Available to your <span className="font-medium text-slate-700">{data?.currentPlan.toUpperCase() ?? "…"}</span> plan ·
            access is enforced server-side at the gateway
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => onNavigate("billing")}>
          <Sparkles className="mr-1.5 h-4 w-4 text-emerald-600" /> Compare plans
        </Button>
      </div>

      {data === null ? (
        <div className="grid gap-4 md:grid-cols-2">
          {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-44 w-full" />)}
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {data.models.map((m) => <ModelCard key={m.id} m={m} onNavigate={onNavigate} />)}
        </div>
      )}
    </div>
  );
}

function ModelCard({ m, onNavigate }: { m: ModelRow; onNavigate: (v: DashboardView) => void }) {
  return (
    <Card className={!m.availableToYou ? "opacity-90" : "border-emerald-200"}>
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-slate-100">
              <Boxes className="h-4.5 w-4.5 text-slate-500" />
            </div>
            <div>
              <CardTitle className="text-base">{m.displayName}</CardTitle>
              <CardDescription className="text-xs">
                <code className="text-slate-400">{m.id}</code> · {m.provider}
              </CardDescription>
            </div>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1.5">
            <Badge variant="outline" className={STATUS_STYLES[m.status] ?? TIER_STYLES.FREE}>
              {STATUS_LABELS[m.status] ?? m.status}
            </Badge>
            <Badge variant="outline" className={TIER_STYLES[m.tierRequirement]}>
              {m.tierRequirement}+
            </Badge>
            {m.availableToYou ? (
              <span className="flex items-center gap-1 text-[11px] font-medium text-emerald-600">
                <CheckCircle2 className="h-3 w-3" /> Available
              </span>
            ) : m.status !== "LIVE" ? (
              <span className="flex items-center gap-1 text-[11px] font-medium text-amber-600">
                <Lock className="h-3 w-3" /> Unavailable on this deployment
              </span>
            ) : (
              <span className="flex items-center gap-1 text-[11px] font-medium text-slate-400">
                <Lock className="h-3 w-3" /> Requires {m.tierRequirement}
              </span>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm leading-relaxed text-slate-600">{m.description}</p>
        <div className="flex flex-wrap gap-1.5">
          {m.capabilities.map((c) => (
            <Badge key={c} variant="outline" className="border-slate-200 bg-slate-50 text-[11px] text-slate-600">
              {capLabel(c)}
            </Badge>
          ))}
          <Badge variant="outline" className="border-slate-200 bg-slate-50 text-[11px] text-slate-600">
            {(m.contextWindow / 1024).toFixed(0)}k context
          </Badge>
          <Badge variant="outline" className="border-slate-200 bg-slate-50 text-[11px] text-slate-600">
            {HOSTING_LABELS[m.hostingMode] ?? m.hostingMode}
          </Badge>
        </div>
        {m.status === "NOT_CONFIGURED" && (
          <p className="text-xs text-amber-700">
            Upstream provider credentials are not configured on this deployment — requests return an honest 503 until they are attached.
          </p>
        )}
        {m.license && (
          <p className="text-[11px] leading-relaxed text-slate-400">
            License: {m.license}
            {m.version ? ` · v${m.version}` : ""}
          </p>
        )}
        {m.pricing && (
          <div className="rounded-lg border border-slate-100 bg-slate-50 px-3 py-2.5">
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-xs">
              <span className="text-slate-500">
                Input <span className="font-semibold text-slate-800">{formatGBP(m.pricing.inputPer1kMicros, { force4dp: true })}</span>/1k tokens
              </span>
              <span className="text-slate-500">
                Output <span className="font-semibold text-slate-800">{formatGBP(m.pricing.outputPer1kMicros, { force4dp: true })}</span>/1k tokens
              </span>
              <span className="text-slate-400">incl. {m.pricing.marginPercent}% platform margin</span>
            </div>
          </div>
        )}
        {!m.availableToYou && m.status === "LIVE" && (
          <Button variant="outline" size="sm" className="w-full border-emerald-300 text-emerald-700 hover:bg-emerald-50" onClick={() => onNavigate("billing")}>
            Upgrade to unlock {m.displayName}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
