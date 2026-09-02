"use client";

/** Dashboard overview — plan, balance, month-to-date usage, trend, quick actions. */

import { useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Progress } from "@/components/ui/progress";
import { PlanBadge, type DashboardView } from "./dashboard-shell";
import { api } from "@/lib/client-api";
import { formatGBP } from "@/lib/money";
import type { MeResponse, UsageResponse } from "@/types/taskflow";
import {
  Wallet, Activity, Coins, KeyRound, ArrowUpRight, Zap, Clock, ShieldCheck,
} from "lucide-react";
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from "recharts";

function Stat({ icon: Icon, label, value, sub, tone = "default" }: {
  icon: React.ComponentType<{ className?: string }>;
  label: string; value: string; sub?: string; tone?: "default" | "emerald" | "amber";
}) {
  const tones = {
    default: "bg-slate-100 text-slate-600",
    emerald: "bg-emerald-100 text-emerald-700",
    amber: "bg-amber-100 text-amber-700",
  };
  return (
    <Card>
      <CardContent className="flex items-start gap-3 p-5">
        <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${tones[tone]}`}>
          <Icon className="h-5 w-5" />
        </div>
        <div className="min-w-0">
          <div className="text-xs font-medium text-slate-500">{label}</div>
          <div className="truncate text-2xl font-bold tracking-tight text-slate-900">{value}</div>
          {sub && <div className="mt-0.5 truncate text-xs text-slate-400">{sub}</div>}
        </div>
      </CardContent>
    </Card>
  );
}

export function OverviewView({ me, onNavigate, refreshMe }: {
  me: MeResponse;
  onNavigate: (v: DashboardView) => void;
  refreshMe: () => Promise<unknown>;
}) {
  const [usage, setUsage] = useState<UsageResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    api<UsageResponse>("/api/usage?days=14")
      .then((d) => { if (alive) setUsage(d); })
      .catch(() => undefined)
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  const sub = me.subscription;
  const allowance = sub?.monthlyCreditMicros ?? 0;
  const usedThisPeriod = me.usageThisMonth.chargedMicros;
  const usedPct = allowance > 0 ? Math.min(100, Math.round((usedThisPeriod / allowance) * 100)) : 0;

  const chartData = (usage?.daily ?? []).map((d) => ({
    date: d.date.slice(5),
    requests: d.requests,
    charge: Math.round(d.chargedMicros) / 10000, // micros → display units (£ × 1e-4)
  }));

  const periodEnd = sub ? new Date(sub.currentPeriodEnd) : null;

  return (
    <div className="space-y-6">
      {/* Greeting + plan row */}
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
        <div>
          <h2 className="text-xl font-bold tracking-tight text-slate-900">
            Welcome back{me.user?.name ? `, ${me.user.name.split(" ")[0]}` : ""} 👋
          </h2>
          <p className="text-sm text-slate-500">
            {sub
              ? <>You are on the <span className="font-medium text-slate-700">{sub.planName}</span> plan · period ends {periodEnd?.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}</>
              : "No active subscription"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <PlanBadge planId={sub?.planId ?? "free"} />
          {sub && (
            <Button variant="outline" size="sm" onClick={() => onNavigate("billing")}>
              {sub.planId === "max" ? "Manage plan" : "Upgrade"} <ArrowUpRight className="ml-1 h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </div>

      {/* Stat cards */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat icon={Wallet} label="Credit balance" value={formatGBP(me.credits.balanceMicros)} sub="AI usage credits" tone="emerald" />
        <Stat icon={Activity} label="Requests this month" value={me.usageThisMonth.requests.toLocaleString()} sub="Successful + failed" />
        <Stat icon={Coins} label="Tokens this month" value={me.usageThisMonth.totalTokens.toLocaleString()} sub={`${me.usageThisMonth.inputTokens.toLocaleString()} in / ${me.usageThisMonth.outputTokens.toLocaleString()} out`} />
        <Stat icon={Zap} label="AI usage this month" value={formatGBP(usedThisPeriod)} sub={allowance > 0 ? `of ${formatGBP(allowance)} allowance` : "no allowance"} tone="amber" />
      </div>

      {/* Allowance + usage trend */}
      <div className="grid gap-4 lg:grid-cols-5">
        <Card className="lg:col-span-2">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Monthly allowance</CardTitle>
            <CardDescription>Included credits with your plan</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-end justify-between">
              <div>
                <div className="text-xs text-slate-500">Used</div>
                <div className="text-2xl font-bold text-slate-900">{formatGBP(usedThisPeriod)}</div>
              </div>
              <div className="text-right">
                <div className="text-xs text-slate-500">Allowance</div>
                <div className="text-2xl font-bold text-slate-400">{formatGBP(allowance)}</div>
              </div>
            </div>
            <Progress value={usedPct} aria-label={`${usedPct}% of allowance used`} />
            <div className="flex items-center justify-between text-xs text-slate-500">
              <span>{usedPct}% of allowance used</span>
              {sub?.canBuyCredits ? (
                <button className="font-medium text-emerald-700 hover:text-emerald-800" onClick={() => onNavigate("billing")}>
                  Buy more credits
                </button>
              ) : (
                <button className="font-medium text-emerald-700 hover:text-emerald-800" onClick={() => onNavigate("billing")}>
                  Upgrade for more credits
                </button>
              )}
            </div>
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-500">
              <div className="mb-1 flex items-center gap-1.5 font-medium text-slate-600">
                <Clock className="h-3.5 w-3.5" /> Allowance resets monthly
              </div>
              Credits refresh at the start of each subscription period. Unused allowance does not roll over;
              purchased credits stay on your balance.
            </div>
          </CardContent>
        </Card>

        <Card className="lg:col-span-3">
          <CardHeader className="flex-row items-center justify-between pb-3">
            <div>
              <CardTitle className="text-base">Usage trend</CardTitle>
              <CardDescription>Requests &amp; spend, last 14 days</CardDescription>
            </div>
            <Button variant="ghost" size="sm" onClick={() => onNavigate("usage")}>
              Full usage <ArrowUpRight className="ml-1 h-3.5 w-3.5" />
            </Button>
          </CardHeader>
          <CardContent>
            {loading ? (
              <Skeleton className="h-56 w-full" />
            ) : chartData.every((d) => d.requests === 0) ? (
              <div className="flex h-56 flex-col items-center justify-center text-center text-sm text-slate-400">
                <Activity className="mb-2 h-8 w-8 text-slate-300" />
                No requests in the last 14 days.
                <button className="mt-2 font-medium text-emerald-700 hover:text-emerald-800" onClick={() => onNavigate("docs")}>
                  Make your first API call →
                </button>
              </div>
            ) : (
              <div className="h-56">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={chartData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                    <defs>
                      <linearGradient id="reqFill" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#10b981" stopOpacity={0.25} />
                        <stop offset="100%" stopColor="#10b981" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                    <XAxis dataKey="date" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} />
                    <YAxis tick={{ fontSize: 11 }} tickLine={false} axisLine={false} allowDecimals={false} width={32} />
                    <Tooltip
                      contentStyle={{ borderRadius: 8, border: "1px solid #e2e8f0", fontSize: 12 }}
                      formatter={(value: number, name: string) =>
                        name === "requests" ? [value, "Requests"] : [`£${(value / 10000).toFixed(4)}`, "Spend"]
                      }
                    />
                    <Area type="monotone" dataKey="requests" stroke="#10b981" strokeWidth={2} fill="url(#reqFill)" />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Quick actions */}
      <div>
        <h3 className="mb-3 text-sm font-semibold text-slate-900">Quick actions</h3>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {[
            { icon: KeyRound, title: "Create API key", desc: "Generate a key for your app", view: "api-keys" as DashboardView },
            { icon: Coins, title: "Buy credits", desc: "Top up your balance", view: "billing" as DashboardView },
            { icon: ArrowUpRight, title: "Upgrade plan", desc: "More credits & models", view: "billing" as DashboardView },
            { icon: BookOpenIcon, title: "Read the docs", desc: "First call in minutes", view: "docs" as DashboardView },
          ].map((a) => (
            <button
              key={a.title}
              onClick={() => onNavigate(a.view)}
              className="group flex items-start gap-3 rounded-xl border border-slate-200 bg-white p-4 text-left transition-all hover:border-emerald-300 hover:shadow-sm"
            >
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-emerald-50 text-emerald-700 group-hover:bg-emerald-100">
                <a.icon className="h-4.5 w-4.5" />
              </div>
              <div>
                <div className="text-sm font-semibold text-slate-900">{a.title}</div>
                <div className="text-xs text-slate-500">{a.desc}</div>
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Platform status strip */}
      <Card>
        <CardContent className="flex flex-col items-start gap-2 p-4 sm:flex-row sm:items-center sm:gap-4">
          <div className="flex items-center gap-2 text-sm font-medium text-slate-700">
            <ShieldCheck className="h-4.5 w-4.5 text-emerald-600" /> Platform status
          </div>
          <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-slate-500">
            <span>Gateway: <span className="font-medium text-emerald-600">operational</span></span>
            <span>Billing: <span className="font-medium">{me.billingMode === "live" ? "Stripe (live)" : me.billingMode === "test" ? "Stripe (test mode)" : "not configured"}</span></span>
            <span>Plan limits: <span className="font-medium">{sub ? `${sub.rateLimitPerMinute} rpm · priority ${sub.priority}` : "—"}</span></span>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function BookOpenIcon(props: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={props.className}>
      <path d="M12 7v14" /><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z" />
    </svg>
  );
}
