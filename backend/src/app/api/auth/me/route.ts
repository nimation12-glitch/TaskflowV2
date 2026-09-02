/**
 * GET /api/auth/me — dashboard bootstrap payload (Phase 1 §23, §28, §42):
 * user + active organization (membership-validated) + all organizations +
 * role + subscription + credits + connected providers + verification state
 * (email AND phone — correction spec §2, §18).
 *
 * PENDING accounts (verification policy unsatisfied, correction spec §17)
 * receive a LIMITED payload — identity + verification state only. No
 * organization data exists for them yet (activation provisions it), and
 * every org-scoped route independently refuses via getOrgContext.
 */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getOrgContext } from "@/server/tenancy/authz";
import { resolveSession } from "@/server/auth/session";
import { ensureCurrentPeriod, planEntitled } from "@/server/billing/subscription";
import { billingMode } from "@/server/stripe";
import { smsTransportStatus } from "@/server/sms";
import { MICRO_PER_POUND } from "@/lib/money";

export async function GET(req: NextRequest) {
  // Pending accounts: identity + verification state, nothing else (§17).
  const resolved = await resolveSession(req);
  if (resolved && resolved.user.status !== "ACTIVE") {
    const user = resolved.user;
    return NextResponse.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        avatarUrl: user.avatarUrl,
        status: user.status,
        emailVerified: Boolean(user.emailVerifiedAt),
        phone: user.phone,
        phoneVerified: Boolean(user.phoneVerifiedAt),
        createdAt: user.createdAt,
        lastLoginAt: user.lastLoginAt,
      },
      pending: true,
      organizations: [],
      organization: null,
      role: null,
      subscription: null,
      credits: { balanceMicros: 0, balanceGBP: 0, autoTopUpEnabled: false },
      usageThisMonth: { requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, chargedMicros: 0 },
      providers: await db.authenticationIdentity.findMany({
        where: { userId: user.id },
        select: { id: true, provider: true, providerEmail: true, createdAt: true },
        orderBy: { createdAt: "asc" },
      }),
      sms: smsTransportStatus(),
      billingMode: billingMode(),
    });
  }

  let ctx;
  try {
    ctx = await getOrgContext(req);
  } catch {
    return NextResponse.json({ user: null }, { status: 401 });
  }
  const { user, organization, role, memberships } = ctx;

  let subscription = await db.subscription.findUnique({
    where: { organizationId: organization.id },
    include: { plan: true },
  });
  if (subscription) {
    await ensureCurrentPeriod(subscription.id);
    subscription = await db.subscription.findUnique({
      where: { id: subscription.id },
      include: { plan: true },
    });
  }

  const account = await db.creditAccount.findUnique({ where: { organizationId: organization.id } });

  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const agg = await db.usageEvent.aggregate({
    where: { organizationId: organization.id, status: "SUCCESS", createdAt: { gte: monthStart } },
    _count: { _all: true },
    _sum: {
      inputTokens: true,
      outputTokens: true,
      customerChargeMicros: true,
    },
  });

  const identities = await db.authenticationIdentity.findMany({
    where: { userId: user.id },
    select: { id: true, provider: true, providerEmail: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });

  return NextResponse.json({
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      avatarUrl: user.avatarUrl,
      status: user.status,
      emailVerified: Boolean(user.emailVerifiedAt),
      phone: user.phone,
      phoneVerified: Boolean(user.phoneVerifiedAt),
      createdAt: user.createdAt,
      lastLoginAt: user.lastLoginAt,
    },
    // Active organization = the membership-validated context (§23).
    organization: { id: organization.id, name: organization.name, slug: organization.slug, isPersonal: organization.ownerUserId === user.id },
    role,
    organizations: memberships.map((m) => ({
      id: m.organization.id,
      name: m.organization.name,
      slug: m.organization.slug,
      role: m.membership.role,
      isPersonal: m.organization.ownerUserId === user.id,
    })),
    subscription: subscription
      ? {
          planId: subscription.planId,
          planName: subscription.plan.name,
          status: subscription.status,
          entitled: planEntitled(subscription.status, subscription.pastDueAt),
          currentPeriodStart: subscription.currentPeriodStart,
          currentPeriodEnd: subscription.currentPeriodEnd,
          cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
          monthlyPriceMicros: subscription.plan.monthlyPriceMicros,
          monthlyCreditMicros: subscription.plan.monthlyCreditMicros,
          rateLimitPerMinute: subscription.plan.rateLimitPerMinute,
          priority: subscription.plan.priority,
          maxConcurrency: subscription.plan.maxConcurrency,
          canRentGpu: subscription.plan.canRentGpu,
          canBuyCredits: subscription.plan.canBuyCredits,
        }
      : null,
    credits: {
      balanceMicros: account?.balanceMicros ?? 0,
      balanceGBP: (account?.balanceMicros ?? 0) / MICRO_PER_POUND,
      autoTopUpEnabled: account?.autoTopUpEnabled ?? false,
    },
    usageThisMonth: {
      requests: agg._count._all,
      inputTokens: agg._sum.inputTokens ?? 0,
      outputTokens: agg._sum.outputTokens ?? 0,
      totalTokens: (agg._sum.inputTokens ?? 0) + (agg._sum.outputTokens ?? 0),
      chargedMicros: agg._sum.customerChargeMicros ?? 0,
    },
    providers: identities,
    sms: smsTransportStatus(),
    billingMode: billingMode(),
  });
}
