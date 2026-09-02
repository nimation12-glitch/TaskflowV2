"use client";

/** Usage — date range, totals, daily chart, model/provider breakdown, recent events. */

import { useCallback, useEffect, useState } from "react";
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/client-api";
import { formatGBP } from "@/lib/money";
import type { UsageResponse } from "@/types/taskflow";
import { Activity, Coins, Wallet, Timer } from "lucide-react";
import {
  AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from "recharts";

const MODEL_COLORS = ["#10b981", "#14b8a6", "#f59e0b", "#84cc16", "#a3a3a3", "#2dd4bf"];

function fmtDate(s: string): string {
  return new Date(s).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

export function UsageView() {
  const [days, setDays] = useState(30);
  const [data, setData] = useState<UsageResponse | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (d: number) => {
    setLoading(true);
    try {
      setData(await api<UsageResponse>(`/api/usage?days=${d}`));
    } catch {
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(days); }, [days, load]);

  const daily = (data?.daily ?? []).map((d) => ({
    date: d.date.slice(5),
    requests: d.requests,
    tokens: d.tokens,
    chargeGBP: d.chargedMicros / 1_000_000,
  }));

  const pieData = (data?.models ?? []).slice(0, 6).map((m) => ({
    name: m.displayName,
    value: m.chargedMicros > 0 ? m.chargedMicros : 1,
    requests: m.requests,
  }));

  return (
    <div className="space-y-5">
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
        <div>
          <h2 className="text-xl font-bold tracking-tight text-slate-900">Usage</h2>
          <p className="text-sm text-slate-500">Token-level accounting across all your API keys</p>
        </div>
        <Tabs value={String(days)} onValueChange={(v) => setDays(Number(v))}>
          <TabsList>
            <TabsTrigger value="7">7d</TabsTrigger>
            <TabsTrigger value="30">30d</TabsTrigger>
            <TabsTrigger value="90">90d</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {/* Totals */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[
          { icon: Activity, label: "Total requests", value: loading ? "…" : (data?.totals.requests ?? 0).toLocaleString(), sub: data ? `${data.totals.failedRequests} failed` : "" },
          { icon: Coins, label: "Total tokens", value: loading ? "…" : (data?.totals.totalTokens ?? 0).toLocaleString(), sub: data ? `${data.totals.inputTokens.toLocaleString()} in / ${data.totals.outputTokens.toLocaleString()} out` : "" },
          { icon: Wallet, label: "AI usage cost", value: loading ? "…" : formatGBP(data?.totals.aiUsageMicros ?? 0), sub: "charged to credits" },
          { icon: Timer, label: "Remaining credits", value: loading ? "…" : formatGBP(data?.credits.balanceMicros ?? 0), sub: data ? `${Math.round(data.totals.computeSeconds)}s GPU time` : "" },
        ].map((s) => (
          <Card key={s.label}>
            <CardContent className="flex items-start gap-3 p-5">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-600">
                <s.icon className="h-5 w-5" />
              </div>
              <div className="min-w-0">
                <div className="text-xs font-medium text-slate-500">{s.label}</div>
                <div className="truncate text-2xl font-bold tracking-tight text-slate-900">{s.value}</div>
                {s.sub && <div className="mt-0.5 truncate text-xs text-slate-400">{s.sub}</div>}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Charts */}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Requests &amp; spend per day</CardTitle>
            <CardDescription>Last {days} days</CardDescription>
          </CardHeader>
          <CardContent>
            {loading ? (
              <Skeleton className="h-64 w-full" />
            ) : (
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={daily} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                    <defs>
                      <linearGradient id="uReqFill" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#10b981" stopOpacity={0.3} />
                        <stop offset="100%" stopColor="#10b981" stopOpacity={0} />
                      </linearGradient>
                      <linearGradient id="uTokFill" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#f59e0b" stopOpacity={0.25} />
                        <stop offset="100%" stopColor="#f59e0b" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                    <XAxis dataKey="date" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} />
                    <YAxis tick={{ fontSize: 11 }} tickLine={false} axisLine={false} width={40} />
                    <Tooltip contentStyle={{ borderRadius: 8, border: "1px solid #e2e8f0", fontSize: 12 }} />
                    <Legend wrapperStyle={{ fontSize: 12 }} />
                    <Area type="monotone" name="Requests" dataKey="requests" stroke="#10b981" strokeWidth={2} fill="url(#uReqFill)" />
                    <Area type="monotone" name="Tokens" dataKey="tokens" stroke="#f59e0b" strokeWidth={2} fill="url(#uTokFill)" />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Spend by model</CardTitle>
            <CardDescription>Share of AI usage cost</CardDescription>
          </CardHeader>
          <CardContent>
            {loading ? (
              <Skeleton className="h-64 w-full" />
            ) : pieData.length === 0 ? (
              <div className="flex h-64 items-center justify-center text-sm text-slate-400">No usage in this period</div>
            ) : (
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={pieData} dataKey="value" nameKey="name" innerRadius={55} outerRadius={85} paddingAngle={2}>
                      {pieData.map((_, i) => (
                        <Cell key={i} fill={MODEL_COLORS[i % MODEL_COLORS.length]} />
                      ))}
                    </Pie>
                    <Tooltip
                      contentStyle={{ borderRadius: 8, border: "1px solid #e2e8f0", fontSize: 12 }}
                      formatter={(value: number, name: string) => [formatGBP(value), name]}
                    />
                    <Legend wrapperStyle={{ fontSize: 12 }} />
                  </PieChart>
                </ResponsiveContainer>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Model breakdown table */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Model breakdown</CardTitle>
          <CardDescription>Where your credits went</CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <Skeleton className="h-32 w-full" />
          ) : (data?.models.length ?? 0) === 0 ? (
            <p className="py-6 text-center text-sm text-slate-400">No model usage in this period</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-140 text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-400">
                    <th className="pb-2 pr-4 font-medium">Model</th>
                    <th className="pb-2 pr-4 font-medium">Provider</th>
                    <th className="pb-2 pr-4 font-medium">Requests</th>
                    <th className="pb-2 pr-4 font-medium">Input tokens</th>
                    <th className="pb-2 pr-4 font-medium">Output tokens</th>
                    <th className="pb-2 font-medium text-right">Charged</th>
                  </tr>
                </thead>
                <tbody>
                  {data!.models.map((m) => (
                    <tr key={m.modelId} className="border-b border-slate-100 last:border-0">
                      <td className="py-2.5 pr-4 font-medium text-slate-900">{m.displayName}</td>
                      <td className="py-2.5 pr-4 text-slate-500">{m.provider}</td>
                      <td className="py-2.5 pr-4 text-slate-600">{m.requests.toLocaleString()}</td>
                      <td className="py-2.5 pr-4 text-slate-600">{m.inputTokens.toLocaleString()}</td>
                      <td className="py-2.5 pr-4 text-slate-600">{m.outputTokens.toLocaleString()}</td>
                      <td className="py-2.5 text-right font-medium text-slate-900">{formatGBP(m.chargedMicros)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Recent events */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Recent requests</CardTitle>
          <CardDescription>Most recent {Math.min(100, data?.recentEvents.length ?? 0)} usage events</CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <Skeleton className="h-40 w-full" />
          ) : (data?.recentEvents.length ?? 0) === 0 ? (
            <p className="py-6 text-center text-sm text-slate-400">No requests yet — see the Docs page to make your first call</p>
          ) : (
            <div className="max-h-96 overflow-y-auto rounded-lg border border-slate-100">
              <table className="w-full min-w-200 text-sm">
                <thead className="sticky top-0 bg-slate-50">
                  <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-400">
                    <th className="px-3 py-2 font-medium">Time</th>
                    <th className="px-3 py-2 font-medium">Model</th>
                    <th className="px-3 py-2 font-medium">Tokens</th>
                    <th className="px-3 py-2 font-medium">Latency</th>
                    <th className="px-3 py-2 font-medium">Charge</th>
                    <th className="px-3 py-2 font-medium">Status</th>
                    <th className="px-3 py-2 font-medium">Request ID</th>
                  </tr>
                </thead>
                <tbody>
                  {data!.recentEvents.map((e) => (
                    <tr key={e.id} className="border-b border-slate-50 last:border-0 hover:bg-slate-50/60">
                      <td className="whitespace-nowrap px-3 py-2 text-slate-500">{fmtDate(e.createdAt)}</td>
                      <td className="px-3 py-2 font-medium text-slate-800">{e.model}</td>
                      <td className="px-3 py-2 text-slate-600">{e.inputTokens.toLocaleString()} / {e.outputTokens.toLocaleString()}</td>
                      <td className="px-3 py-2 text-slate-600">{e.latencyMs} ms</td>
                      <td className="px-3 py-2 font-medium text-slate-800">{formatGBP(e.chargeMicros)}</td>
                      <td className="px-3 py-2">
                        {e.status === "SUCCESS"
                          ? <Badge variant="outline" className="border-emerald-300 bg-emerald-50 text-emerald-700">OK</Badge>
                          : <Badge variant="outline" className="border-rose-300 bg-rose-50 text-rose-700">Failed</Badge>}
                      </td>
                      <td className="px-3 py-2">
                        <code className="rounded bg-slate-100 px-1 py-0.5 text-[11px] text-slate-500">{e.requestId.slice(0, 18)}…</code>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
