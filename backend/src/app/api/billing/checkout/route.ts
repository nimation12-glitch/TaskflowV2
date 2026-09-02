/**
 * POST /api/billing/checkout — start a REAL Stripe Checkout for a plan
 * change or credit pack (spec §4, §5, §6, §12).
 *
 * FAIL CLOSED (§1, §14): when Stripe configuration is missing the endpoint
 * returns 503 — there is no simulated checkout, no local state mutation,
 * no fake credits. State changes happen ONLY via verified Stripe events
 * (webhooks + verification-on-return).
 *
 * Checkout metadata identifies the TaskFlow organization server-side:
 *   organization_id, plan, purchase_type
 * — customer-supplied identifiers are never trusted (§12).
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireOrgRole, OrgContextError } from "@/server/tenancy/authz";
import { serverEnv } from "@/server/env";
import { billingMode, ensureOrgStripeCustomer, getStripe, BillingUnavailableError } from "@/server/stripe";
import { billingConfigIssues } from "@/server/startup";
import { CREDIT_PACKAGES, MICRO_PER_POUND } from "@/lib/money";
import type Stripe from "stripe";

const schema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("subscription"), planId: z.enum(["free", "pro", "max"]) }),
  z.object({ kind: z.literal("credits"), amountMicros: z.number().int().positive() }),
]);

function creditPriceFor(micros: number): string | undefined {
  if (micros === CREDIT_PACKAGES[0].micros) return serverEnv.stripePriceCredit10;
  if (micros === CREDIT_PACKAGES[1].micros) return serverEnv.stripePriceCredit25;
  if (micros === CREDIT_PACKAGES[2].micros) return serverEnv.stripePriceCredit50;
  if (micros === CREDIT_PACKAGES[3].micros) return serverEnv.stripePriceCredit100;
  return undefined;
}

function checkoutUnavailable() {
  return NextResponse.json(
    {
      error: "Billing is not available on this deployment: Stripe configuration is missing.",
      configIssues: billingConfigIssues(),
      mode: "unconfigured",
    },
    { status: 503 },
  );
}

export async function POST(req: NextRequest) {
  // Billing actions are OWNER-only (Phase 1 §25).
  let ctx;
  try {
    ctx = await requireOrgRole(req, "OWNER");
  } catch (err) {
    if (err instanceof OrgContextError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
  const user = ctx.user;

  let parsed;
  try {
    parsed = schema.safeParse(await req.json());
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid checkout request" }, { status: 400 });
  }

  // ── Fail closed without real Stripe configuration (§1, §14) ──
  if (!serverEnv.stripeSecretKey) return checkoutUnavailable();

  // Billing ownership: User → Membership → ACTIVE Organization (§3, §23)
  const org = ctx.organization;

  const successUrl = `${serverEnv.frontendBaseUrl}/?status=success&session_id={CHECKOUT_SESSION_ID}#/dashboard/billing`;
  const cancelUrl = `${serverEnv.frontendBaseUrl}/?status=cancelled#/dashboard/billing`;

  try {
    // ── Credit purchase ──────────────────────────────────────
    if (parsed.data.kind === "credits") {
      const pkg = CREDIT_PACKAGES.find((p) => p.micros === parsed.data.amountMicros);
      if (!pkg) {
        return NextResponse.json(
          { error: "Unknown credit package", available: CREDIT_PACKAGES.map((p) => p.label) },
          { status: 400 },
        );
      }
      const sub = await db.subscription.findUnique({ where: { organizationId: org.id } });
      const plan = sub ? await db.plan.findUnique({ where: { id: sub.planId } }) : null;
      if (plan && !plan.canBuyCredits) {
        return NextResponse.json(
          { error: "Credit purchases require the Pro or Max plan" },
          { status: 403 },
        );
      }

      const priceId = creditPriceFor(pkg.micros);
      if (!priceId) {
        return NextResponse.json(
          {
            error: `Stripe price for the ${pkg.label} credit pack is not configured on this deployment.`,
            configIssues: billingConfigIssues(),
          },
          { status: 503 },
        );
      }

      const customerId = await ensureOrgStripeCustomer(org, user);
      const stripe = await getStripe();
      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        customer: customerId,
        line_items: [{ price: priceId, quantity: 1 }],
        metadata: {
          organization_id: org.id,
          plan: "",
          purchase_type: "credits",
          package: pkg.label,
          amount_micros: String(pkg.micros),
        },
        success_url: successUrl,
        cancel_url: cancelUrl,
      });
      return NextResponse.json({ mode: billingMode(), checkoutUrl: session.url });
    }

    // ── Plan subscription ────────────────────────────────────
    const plan = await db.plan.findUnique({ where: { id: parsed.data.planId } });
    if (!plan || !plan.isActive) {
      return NextResponse.json({ error: "Unknown plan" }, { status: 400 });
    }

    // Downgrade to Free = cancel the real Stripe subscription at period end.
    if (plan.id === "free") {
      const sub = await db.subscription.findUnique({ where: { organizationId: org.id } });
      if (sub?.stripeSubscriptionId) {
        const stripe = await getStripe();
        await stripe.subscriptions.update(sub.stripeSubscriptionId, {
          cancel_at_period_end: true,
        });
        await db.subscription.update({
          where: { id: sub.id },
          data: { cancelAtPeriodEnd: true },
        });
      } else if (sub) {
        await db.subscription.update({
          where: { id: sub.id },
          data: { cancelAtPeriodEnd: true },
        });
      }
      return NextResponse.json({
        mode: billingMode(),
        downgraded: true,
        message: "Your plan will switch to Free at the end of the current period.",
      });
    }

    const priceId = plan.id === "pro" ? serverEnv.stripePricePro : plan.id === "max" ? serverEnv.stripePriceMax : null;
    if (!priceId) {
      return NextResponse.json(
        {
          error: `Stripe price for the ${plan.name} plan is not configured on this deployment.`,
          configIssues: billingConfigIssues(),
        },
        { status: 503 },
      );
    }

    const customerId = await ensureOrgStripeCustomer(org, user);
    const stripe = await getStripe();
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      metadata: {
        organization_id: org.id,
        plan: plan.id,
        purchase_type: "subscription",
        stripe_price_id: priceId,
      },
      subscription_data: {
        metadata: {
          organization_id: org.id,
          plan: plan.id,
          purchase_type: "subscription",
        },
      },
      success_url: successUrl,
      cancel_url: cancelUrl,
    });
    return NextResponse.json({ mode: billingMode(), checkoutUrl: session.url });
  } catch (err) {
    if (err instanceof BillingUnavailableError) {
      return checkoutUnavailable();
    }
    console.error("[billing/checkout] Stripe error:", err instanceof Error ? err.message : err);
    return NextResponse.json(
      { error: "Stripe checkout could not be created. Check billing configuration." },
      { status: 502 },
    );
  }
}

// GET returns purchasable context (packages, plans, mode) for the billing UI.
export async function GET(req: NextRequest) {
  try {
    await requireOrgRole(req, "MEMBER");
  } catch (err) {
    if (err instanceof OrgContextError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }

  const plans = await db.plan.findMany({
    where: { isActive: true },
    orderBy: { sortOrder: "asc" },
  });
  return NextResponse.json({
    mode: billingMode(),
    plans: plans.map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      monthlyPriceMicros: p.monthlyPriceMicros,
      monthlyPriceGBP: p.monthlyPriceMicros / MICRO_PER_POUND,
      monthlyCreditMicros: p.monthlyCreditMicros,
      monthlyCreditGBP: p.monthlyCreditMicros / MICRO_PER_POUND,
      rateLimitPerMinute: p.rateLimitPerMinute,
      priority: p.priority,
      maxConcurrency: p.maxConcurrency,
      canRentGpu: p.canRentGpu,
      canBuyCredits: p.canBuyCredits,
    })),
    creditPackages: CREDIT_PACKAGES.map((p) => ({
      label: p.label,
      amountMicros: p.micros,
      amountGBP: p.micros / MICRO_PER_POUND,
      priceConfigured: Boolean(creditPriceFor(p.micros)),
    })),
    pricesConfigured: {
      pro: Boolean(serverEnv.stripePricePro),
      max: Boolean(serverEnv.stripePriceMax),
    },
    configIssues: billingConfigIssues(),
  });
}
