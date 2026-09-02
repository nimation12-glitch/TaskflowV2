/**
 * Subscription lifecycle service — organization-anchored (spec §3, §8, §9, §10).
 *
 * Key behaviour: LAZY PERIOD ROLLOVER.
 *  - Free / non-Stripe subscriptions: period advance + monthly allowance grant
 *    (no Stripe involvement; deduped per period).
 *  - Stripe-paid subscriptions: the allowance is granted ONLY when Stripe
 *    confirms entitlement. The rollover consults the Stripe API
 *    (authoritative) before advancing anything; the primary grant path is
 *    the verified webhook (invoice.paid / checkout.session.completed).
 *    A PAST_DUE / PAYMENT_FAILED / INCOMPLETE / CANCELED subscription never
 *    receives a rollover grant.
 *
 * Entitlement semantics (spec §9, §10):
 *   ACTIVE/TRIALING  → full plan entitlement
 *   PAST_DUE         → plan entitlement kept for the configured grace window
 *                      only (pastDueAt + PAST_DUE_GRACE_DAYS), then removed
 *   PAYMENT_FAILED   → entitlement removed
 *   CANCELED         → entitlement removed
 *   INCOMPLETE       → entitlement removed
 */
import { db } from "@/lib/db";
import { grantCredits } from "@/server/billing/ledger";
import { serverEnv } from "@/server/env";
import type { Plan, Subscription } from "@prisma/client";

const STATUSES_WITH_ENTITLEMENT = new Set(["ACTIVE", "TRIALING"]);

/** Days a PAST_DUE subscription keeps access before restriction (spec §10). */
export const PAST_DUE_GRACE_DAYS = 7;

/**
 * Whether a subscription status grants paid entitlement.
 * PAST_DUE is entitled only inside the grace window measured from pastDueAt.
 */
export function planEntitled(status: string, pastDueAt?: Date | null, now: Date = new Date()): boolean {
  if (STATUSES_WITH_ENTITLEMENT.has(status)) return true;
  if (status === "PAST_DUE") {
    if (!pastDueAt) return true; // no failure timestamp recorded — keep legacy grace
    const graceEnd = new Date(pastDueAt);
    graceEnd.setDate(graceEnd.getDate() + PAST_DUE_GRACE_DAYS);
    return now < graceEnd;
  }
  return false;
}

/** Canonical idempotency key for a monthly allowance grant of a Stripe period. */
export function stripePeriodGrantKey(stripeSubscriptionId: string, periodStart: Date): string {
  return `stripe_sub_${stripeSubscriptionId}_${periodStart.toISOString().slice(0, 19)}`;
}

export function addPeriod(from: Date, days: number): Date {
  const d = new Date(from);
  d.setDate(d.getDate() + days);
  return d;
}

/**
 * Move a subscription onto a plan (fulfillment / signup / legacy repair).
 * Org-anchored: the subscription row is keyed by organizationId.
 * NOTE: in Stripe mode this is driven by verified webhooks / checkout
 * verification — never by the frontend announcing a payment.
 */
export async function ensureOrgSubscription(opts: {
  organizationId: string;
  userId: string;
  planId: string;
  status?: string;
  stripeSubscriptionId?: string | null;
  stripePriceId?: string | null;
  stripeCustomerId?: string | null;
  stripeCheckoutSessionId?: string | null;
  grantCreditsNow?: boolean;
  periodStart?: Date;
  periodEnd?: Date;
}): Promise<Subscription> {
  const plan = await db.plan.findUnique({ where: { id: opts.planId } });
  if (!plan) throw new Error(`Unknown plan: ${opts.planId}`);

  const now = new Date();
  const periodStart = opts.periodStart ?? now;
  const periodEnd = opts.periodEnd ?? addPeriod(periodStart, 30);
  const data = {
    planId: plan.id,
    status: opts.status ?? "ACTIVE",
    currentPeriodStart: periodStart,
    currentPeriodEnd: periodEnd,
    cancelAtPeriodEnd: false,
    pastDueAt: null,
    stripeSubscriptionId: opts.stripeSubscriptionId ?? null,
    stripePriceId: opts.stripePriceId ?? null,
    stripeCustomerId: opts.stripeCustomerId ?? null,
    stripeCheckoutSessionId: opts.stripeCheckoutSessionId ?? null,
  };

  const existing = await db.subscription.findUnique({ where: { organizationId: opts.organizationId } });
  const sub = existing
    ? await db.subscription.update({ where: { id: existing.id }, data })
    : await db.subscription.create({
        data: { organizationId: opts.organizationId, userId: opts.userId, ...data },
      });

  if (opts.grantCreditsNow !== false && plan.monthlyCreditMicros > 0) {
    // Deterministic grant key per Stripe source: the subscription period when
    // known, otherwise the checkout session itself (never the wall clock —
    // clock-based keys are not idempotent).
    const key = opts.stripeSubscriptionId
      ? stripePeriodGrantKey(opts.stripeSubscriptionId, periodStart)
      : opts.stripeCheckoutSessionId
        ? `stripe_cs_${opts.stripeCheckoutSessionId}`
        : `signup_${sub.id}_${periodStart.toISOString().slice(0, 19)}`;
    await grantCredits({
      userId: opts.userId,
      organizationId: opts.organizationId,
      amountMicros: plan.monthlyCreditMicros,
      type: "MONTHLY_GRANT",
      description: `Monthly ${plan.name} plan credits`,
      periodStart,
      periodEnd,
      uniqueGrantKey: key,
    });
  }
  return sub;
}

/**
 * Lazy period maintenance. Called on dashboard/API reads.
 * NEVER grants Stripe-plan credits without authoritative entitlement:
 *  - non-Stripe (free) subscriptions roll over locally, grant deduped per period;
 *  - Stripe subscriptions are reconciled against the Stripe API before any
 *    period advance / grant; unreachable Stripe → no state change, no grant.
 */
export async function ensureCurrentPeriod(subscriptionId: string): Promise<Subscription & { plan: Plan }> {
  const sub = await db.subscription.findUniqueOrThrow({
    where: { id: subscriptionId },
    include: { plan: true },
  });
  const now = new Date();
  const needsRenewal = sub.currentPeriodEnd <= now;
  if (!needsRenewal) return sub;

  // ── Non-Stripe subscription: local rollover (free plan or legacy rows) ──
  if (!sub.stripeSubscriptionId) {
    if (sub.status === "CANCELED" || sub.cancelAtPeriodEnd) {
      return downgradeToFree(sub, now);
    }
    return advancePeriodAndGrant(sub, sub.plan.monthlyCreditMicros, sub.plan.name, now);
  }

  // ── Stripe-paid subscription: consult the authoritative source ──
  if (sub.status === "CANCELED") {
    return downgradeToFree(sub, now);
  }
  if (sub.status !== "ACTIVE" && sub.status !== "TRIALING") {
    // PAST_DUE / PAYMENT_FAILED / INCOMPLETE: no new credits, no period advance.
    return sub;
  }

  const secretKey = serverEnv.stripeSecretKey;
  if (!secretKey) {
    // Cannot verify entitlement → refuse to grant (fail closed).
    console.warn(`[billing] period rollover skipped for sub ${sub.id}: Stripe not configured`);
    return sub;
  }

  try {
    const { getStripe } = await import("@/server/stripe");
    const stripe = await getStripe();
    const remote = (await stripe.subscriptions.retrieve(sub.stripeSubscriptionId)) as unknown as {
      status: string;
      current_period_start?: number;
      current_period_end?: number;
      items?: { data?: Array<{ current_period_start?: number; current_period_end?: number }> };
    };
    const remoteStatus = String(remote.status);
    // Period may be top-level (pre-basil API) or on the subscription item (basil+).
    const item = remote.items?.data?.[0];
    const periodStartUnix = remote.current_period_start ?? item?.current_period_start;
    const periodEndUnix = remote.current_period_end ?? item?.current_period_end;

    if (remoteStatus === "canceled") {
      await db.subscription.update({
        where: { id: sub.id },
        data: { status: "CANCELED", cancelAtPeriodEnd: false },
      });
      return downgradeToFree(sub, now);
    }
    if (remoteStatus !== "active" && remoteStatus !== "trialing") {
      // Stripe says the customer is not entitled to a new period.
      await db.subscription.update({
        where: { id: sub.id },
        data: { status: mapStripeStatus(remoteStatus) },
      });
      return db.subscription.findUniqueOrThrow({ where: { id: sub.id }, include: { plan: true } });
    }

    // Entitled. Advance to Stripe's period if it moved; grant the allowance
    // once per Stripe period (unique key also dedupes against invoice.paid).
    const remotePeriodStart = periodStartUnix ? new Date(periodStartUnix * 1000) : now;
    const remotePeriodEnd = periodEndUnix ? new Date(periodEndUnix * 1000) : addPeriod(remotePeriodStart, 30);
    await db.subscription.update({
      where: { id: sub.id },
      data: {
        status: remoteStatus === "trialing" ? "TRIALING" : "ACTIVE",
        currentPeriodStart: remotePeriodStart,
        currentPeriodEnd: remotePeriodEnd,
        pastDueAt: null,
      },
    });
    if (sub.plan.monthlyCreditMicros > 0) {
      await grantCredits({
        userId: sub.userId,
        organizationId: sub.organizationId,
        amountMicros: sub.plan.monthlyCreditMicros,
        type: "MONTHLY_GRANT",
        description: `Monthly ${sub.plan.name} plan credits`,
        periodStart: remotePeriodStart,
        periodEnd: remotePeriodEnd,
        uniqueGrantKey: stripePeriodGrantKey(sub.stripeSubscriptionId, remotePeriodStart),
      });
    }
    return db.subscription.findUniqueOrThrow({ where: { id: sub.id }, include: { plan: true } });
  } catch (err) {
    console.warn(
      `[billing] Stripe reconciliation failed for sub ${sub.id}: ${err instanceof Error ? err.message : err}`,
    );
    return sub;
  }
}

/** Advance the period and grant the allowance, deduped per period. */
async function advancePeriodAndGrant(
  sub: Subscription & { plan: { name: string; monthlyCreditMicros: number } },
  amountMicros: number,
  planName: string,
  now: Date,
): Promise<Subscription & { plan: Plan }> {
  const periodStart = sub.currentPeriodEnd;
  const periodEnd = addPeriod(periodStart, 30);
  await db.subscription.update({
    where: { id: sub.id },
    data: { currentPeriodStart: periodStart, currentPeriodEnd: periodEnd },
  });
  if (amountMicros > 0) {
    await grantCredits({
      userId: sub.userId,
      organizationId: sub.organizationId,
      amountMicros,
      type: "MONTHLY_GRANT",
      description: `Monthly ${planName} plan credits`,
      periodStart,
      periodEnd,
      uniqueGrantKey: `manual_${sub.id}_${periodStart.toISOString().slice(0, 19)}`,
    });
  }
  return db.subscription.findUniqueOrThrow({ where: { id: sub.id }, include: { plan: true } });
}

/**
 * Canceled/expired subscription → Free plan. Historical usage and ledger rows
 * are NEVER deleted (spec §11); the paid row simply stops being the future.
 */
async function downgradeToFree(sub: Subscription, now: Date): Promise<Subscription & { plan: Plan }> {
  const free = await db.plan.findUnique({ where: { id: "free" } });
  if (!free) {
    // No Free plan on this deployment — leave the row untouched.
    return db.subscription.findUniqueOrThrow({ where: { id: sub.id }, include: { plan: true } });
  }
  const periodEnd = addPeriod(now, 30);
  const [updated] = await db.$transaction([
    db.subscription.update({
      where: { id: sub.id },
      data: {
        planId: "free",
        status: "ACTIVE",
        cancelAtPeriodEnd: false,
        pastDueAt: null,
        currentPeriodStart: now,
        currentPeriodEnd: periodEnd,
        stripeSubscriptionId: null,
        stripePriceId: null,
      },
    }),
  ]);
  if (free.monthlyCreditMicros > 0) {
    await grantCredits({
      userId: sub.userId,
      organizationId: sub.organizationId,
      amountMicros: free.monthlyCreditMicros,
      type: "MONTHLY_GRANT",
      description: `Monthly ${free.name} plan credits`,
      periodStart: now,
      periodEnd,
      uniqueGrantKey: `manual_${sub.id}_${now.toISOString().slice(0, 19)}`,
    });
  }
  return db.subscription.findUniqueOrThrow({ where: { id: updated.id }, include: { plan: true } });
}

/** Map a Stripe subscription status to the TaskFlow status set (spec §9). */
export function mapStripeStatus(stripeStatus: string): string {
  switch (stripeStatus) {
    case "active":
      return "ACTIVE";
    case "trialing":
      return "TRIALING";
    case "past_due":
      return "PAST_DUE";
    case "unpaid":
      return "PAYMENT_FAILED";
    case "incomplete":
    case "incomplete_expired":
      return "INCOMPLETE";
    case "canceled":
      return "CANCELED";
    default:
      return "INCOMPLETE";
  }
}
