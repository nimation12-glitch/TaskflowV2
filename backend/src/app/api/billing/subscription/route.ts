/**
 * /api/billing/subscription — GET current subscription detail (any member);
 * POST { action: "cancel" | "resume" } manages cancellation — OWNER-only
 * (§25: billing actions are owner-only).
 *
 * Cancel/resume operate on the REAL Stripe subscription when one exists
 * (spec §11): cancel_at_period_end is set through the Stripe API and mirrored
 * locally. TaskFlow state converges from Stripe webhooks.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireOrgRole, OrgContextError } from "@/server/tenancy/authz";
import { serverEnv } from "@/server/env";
import { getStripe, BillingUnavailableError } from "@/server/stripe";
import { getOrgSubscription } from "@/server/billing/org";
import { ensureCurrentPeriod } from "@/server/billing/subscription";
import { MICRO_PER_POUND } from "@/lib/money";

function ctxError(err: unknown): NextResponse | null {
  if (err instanceof OrgContextError) {
    return NextResponse.json({ error: err.message }, { status: err.status });
  }
  return null;
}

export async function GET(req: NextRequest) {
  let orgId: string;
  try {
    const ctx = await requireOrgRole(req, "MEMBER");
    orgId = ctx.organization.id;
  } catch (err) {
    const e = ctxError(err);
    if (e) return e;
    throw err;
  }

  let sub = await getOrgSubscription(orgId);
  if (!sub) return NextResponse.json({ subscription: null });

  await ensureCurrentPeriod(sub.id);
  sub = await getOrgSubscription(orgId);
  if (!sub) return NextResponse.json({ subscription: null });

  return NextResponse.json({
    subscription: {
      planId: sub.planId,
      planName: sub.plan.name,
      status: sub.status,
      currentPeriodStart: sub.currentPeriodStart,
      currentPeriodEnd: sub.currentPeriodEnd,
      cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
      monthlyPriceMicros: sub.plan.monthlyPriceMicros,
      monthlyPriceGBP: sub.plan.monthlyPriceMicros / MICRO_PER_POUND,
      includedCreditMicros: sub.plan.monthlyCreditMicros,
      includedCreditGBP: sub.plan.monthlyCreditMicros / MICRO_PER_POUND,
      stripeSubscriptionId: sub.stripeSubscriptionId,
    },
  });
}

const schema = z.object({ action: z.enum(["cancel", "resume"]) });

export async function POST(req: NextRequest) {
  let ctx;
  try {
    ctx = await requireOrgRole(req, "OWNER");
  } catch (err) {
    const e = ctxError(err);
    if (e) return e;
    throw err;
  }

  let parsed;
  try {
    parsed = schema.safeParse(await req.json());
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!parsed.success) {
    return NextResponse.json({ error: "action must be 'cancel' or 'resume'" }, { status: 400 });
  }

  const sub = await db.subscription.findUnique({ where: { organizationId: ctx.organization.id } });
  if (!sub) return NextResponse.json({ error: "No subscription found" }, { status: 404 });

  const cancelAtPeriodEnd = parsed.data.action === "cancel";

  if (cancelAtPeriodEnd && sub.planId === "free") {
    return NextResponse.json({ error: "The Free plan cannot be cancelled" }, { status: 400 });
  }

  // Drive the real Stripe subscription; mirror locally after Stripe accepts.
  if (sub.stripeSubscriptionId && serverEnv.stripeSecretKey) {
    try {
      const stripe = await getStripe();
      await stripe.subscriptions.update(sub.stripeSubscriptionId, {
        cancel_at_period_end: cancelAtPeriodEnd,
      });
    } catch (err) {
      if (err instanceof BillingUnavailableError) {
        return NextResponse.json({ error: err.message }, { status: 503 });
      }
      console.error("[billing/subscription] Stripe update failed:", err instanceof Error ? err.message : err);
      return NextResponse.json(
        { error: "Stripe could not update the subscription. Please retry." },
        { status: 502 },
      );
    }
  }

  await db.subscription.update({
    where: { id: sub.id },
    data: { cancelAtPeriodEnd },
  });

  return NextResponse.json({
    ok: true,
    message: cancelAtPeriodEnd
      ? "Cancellation scheduled with Stripe — your plan switches to Free at the end of the current period."
      : "Cancellation reversed — your plan continues.",
  });
}
