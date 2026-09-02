/**
 * GET /api/usage?days=30 — usage analytics for the dashboard:
 * totals, daily series, model breakdown, provider breakdown, recent events.
 */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getOrgContext, OrgContextError } from "@/server/tenancy/authz";
import { MICRO_PER_POUND } from "@/lib/money";

export async function GET(req: NextRequest) {
  let orgId: string;
  try {
    const ctx = await getOrgContext(req);
    orgId = ctx.organization.id;
  } catch (err) {
    if (err instanceof OrgContextError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
  // ORGANIZATION-SCOPED analytics (Phase 1 §24): every member sees the
  // organization's usage; nobody sees another tenant's.

  const url = new URL(req.url);
  const days = Math.min(90, Math.max(1, Number(url.searchParams.get("days") ?? 30)));
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const [totals, events, account] = await Promise.all([
    db.usageEvent.aggregate({
      where: { organizationId: orgId, createdAt: { gte: since } },
      _count: { _all: true },
      _sum: {
        inputTokens: true,
        outputTokens: true,
        totalTokens: true,
        customerChargeMicros: true,
        computeSeconds: true,
      },
    }),
    db.usageEvent.findMany({
      where: { organizationId: orgId, createdAt: { gte: since } },
      orderBy: { createdAt: "desc" },
      take: 100,
      include: { model: { select: { displayName: true } } },
    }),
    db.creditAccount.findUnique({ where: { organizationId: orgId } }),
  ]);

  const successCount = await db.usageEvent.count({
    where: { organizationId: orgId, createdAt: { gte: since }, status: "SUCCESS" },
  });

  // Daily series (UTC day buckets) — chart-ready.
  const dailyMap = new Map<string, { requests: number; chargedMicros: number; tokens: number }>();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
    dailyMap.set(d.toISOString().slice(0, 10), { requests: 0, chargedMicros: 0, tokens: 0 });
  }
  const modelMap = new Map<string, { requests: number; chargedMicros: number; inputTokens: number; outputTokens: number; displayName: string; provider: string }>();
  const providerMap = new Map<string, { requests: number; chargedMicros: number }>();

  const sinceEarly = new Date(since.getTime() - 24 * 60 * 60 * 1000);
  const aggEvents = await db.usageEvent.findMany({
    where: { organizationId: orgId, createdAt: { gte: sinceEarly }, status: "SUCCESS" },
    select: {
      createdAt: true,
      customerChargeMicros: true,
      totalTokens: true,
      modelId: true,
      provider: true,
      model: { select: { displayName: true } },
    },
  });

  for (const e of aggEvents) {
    const day = e.createdAt.toISOString().slice(0, 10);
    const daily = dailyMap.get(day);
    if (daily) {
      daily.requests += 1;
      daily.chargedMicros += e.customerChargeMicros;
      daily.tokens += e.totalTokens;
    }
    const m = modelMap.get(e.modelId) ?? {
      requests: 0,
      chargedMicros: 0,
      inputTokens: 0,
      outputTokens: 0,
      displayName: e.model.displayName,
      provider: e.provider,
    };
    m.requests += 1;
    m.chargedMicros += e.customerChargeMicros;
    modelMap.set(e.modelId, m);

    const p = providerMap.get(e.provider) ?? { requests: 0, chargedMicros: 0 };
    p.requests += 1;
    p.chargedMicros += e.customerChargeMicros;
    providerMap.set(e.provider, p);
  }

  return NextResponse.json({
    period: { days, since },
    totals: {
      requests: totals._count._all,
      successfulRequests: successCount,
      failedRequests: totals._count._all - successCount,
      inputTokens: totals._sum.inputTokens ?? 0,
      outputTokens: totals._sum.outputTokens ?? 0,
      totalTokens: totals._sum.totalTokens ?? 0,
      aiUsageMicros: totals._sum.customerChargeMicros ?? 0,
      aiUsageGBP: (totals._sum.customerChargeMicros ?? 0) / MICRO_PER_POUND,
      computeSeconds: totals._sum.computeSeconds ?? 0,
    },
    credits: {
      balanceMicros: account?.balanceMicros ?? 0,
      remainingGBP: (account?.balanceMicros ?? 0) / MICRO_PER_POUND,
    },
    daily: [...dailyMap.entries()].map(([date, v]) => ({ date, ...v })),
    models: [...modelMap.entries()]
      .map(([modelId, v]) => ({ modelId, ...v }))
      .sort((a, b) => b.chargedMicros - a.chargedMicros),
    providers: [...providerMap.entries()].map(([provider, v]) => ({ provider, ...v })),
    recentEvents: events.map((e) => ({
      id: e.id,
      requestId: e.requestId,
      model: e.model.displayName,
      modelId: e.modelId,
      provider: e.provider,
      inputTokens: e.inputTokens,
      outputTokens: e.outputTokens,
      status: e.status,
      latencyMs: e.latencyMs,
      chargeMicros: e.customerChargeMicros,
      createdAt: e.createdAt,
    })),
  });
}
