/**
 * GET /api/billing/checkout/verify?session_id=cs_… — verification-on-return.
 *
 * When the customer returns from Stripe Checkout, the server re-reads the
 * Checkout Session DIRECTLY from the Stripe API (server-to-server, §6) and
 * applies the same idempotent fulfillment used by webhooks. This is the
 * reliable backup for webhook latency/failure and the primary path in local
 * TEST MODE when no public webhook endpoint is configured.
 *
 * SECURITY (§12):
 *  - The caller must be authenticated and the session's metadata must point
 *    at THEIR organization. Ownership is validated against the DB, never the
 *    URL. A session id belonging to another org → 403.
 *  - Credits are granted only because Stripe's API says payment_status=paid —
 *    never because the frontend claims success.
 */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireOrgRole, OrgContextError, type OrgContext } from "@/server/tenancy/authz";
import { serverEnv } from "@/server/env";
import { getStripe, BillingUnavailableError } from "@/server/stripe";
import { fulfillCreditPurchase, fulfillSubscriptionCheckout, planIdForStripePrice } from "@/server/billing/fulfillment";

export async function GET(req: NextRequest) {
  // OWNER-only (§25): checkout verification acts on the organization's
  // subscription and credit balance.
  let user: OrgContext["user"];
  let org: OrgContext["organization"];
  try {
    const ctx = await requireOrgRole(req, "OWNER");
    user = ctx.user;
    org = ctx.organization;
  } catch (err) {
    if (err instanceof OrgContextError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }

  if (!serverEnv.stripeSecretKey) {
    return NextResponse.json({ error: "Billing is not configured on this deployment." }, { status: 503 });
  }

  const sessionId = req.nextUrl.searchParams.get("session_id");
  if (!sessionId || !sessionId.startsWith("cs_")) {
    return NextResponse.json({ error: "A Stripe checkout session_id is required" }, { status: 400 });
  }

  try {
    const stripe = await getStripe();
    const session = (await stripe.checkout.sessions.retrieve(sessionId)) as unknown as {
      id: string;
      mode: string;
      status: string | null;
      payment_status: string;
      customer: string | null;
      payment_intent: string | null;
      subscription: string | null;
      metadata: Record<string, string> | null;
    };

    // ── Ownership validation (§12) ───────────────────────────
    const metaOrgId = session.metadata?.organization_id ?? session.metadata?.taskflowOrganizationId;
    if (!metaOrgId || metaOrgId !== org.id) {
      return NextResponse.json({ error: "This checkout session does not belong to your organization" }, { status: 403 });
    }
    // Adopt/verify the Stripe customer link on the organization.
    if (session.customer && !org.stripeCustomerId) {
      await db.organization.update({
        where: { id: org.id },
        data: { stripeCustomerId: session.customer },
      });
      org.stripeCustomerId = session.customer;
    }

    if (session.mode === "payment") {
      if (session.payment_status !== "paid") {
        return NextResponse.json({ fulfilled: false, reason: `payment_status=${session.payment_status}` });
      }
      const amountMicros = Number(session.metadata?.amount_micros ?? 0);
      const summary = await fulfillCreditPurchase({
        orgId: org.id,
        userId: user.id, // session user is the owner of the personal billing org
        amountMicros,
        label: session.metadata?.package ?? "",
        checkoutSessionId: session.id,
        paymentIntentId: typeof session.payment_intent === "string" ? session.payment_intent : null,
        eventId: null,
      });
      return NextResponse.json({ fulfilled: true, summary });
    }

    if (session.mode === "subscription") {
      if (session.status !== "complete") {
        return NextResponse.json({ fulfilled: false, reason: `session_status=${session.status}` });
      }
      const stripePriceId =
        (session as unknown as { line_items?: { data?: Array<{ price?: { id?: string } }> } }).line_items?.data?.[0]
          ?.price?.id ?? session.metadata?.stripe_price_id ?? null;
      const planId = planIdForStripePrice(stripePriceId) ?? session.metadata?.plan ?? null;
      if (!planId || !["pro", "max"].includes(planId)) {
        return NextResponse.json({ error: `Unrecognised plan on the checkout session: ${planId}` }, { status: 422 });
      }
      const summary = await fulfillSubscriptionCheckout({
        org,
        planId,
        checkoutSessionId: session.id,
        stripeSubscriptionId: typeof session.subscription === "string" ? session.subscription : null,
        stripeCustomerId: typeof session.customer === "string" ? session.customer : null,
        stripePriceId,
        eventId: null,
      });
      return NextResponse.json({ fulfilled: true, summary });
    }

    return NextResponse.json({ error: `Unsupported checkout mode: ${session.mode}` }, { status: 422 });
  } catch (err) {
    if (err instanceof BillingUnavailableError) {
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    if (err instanceof Error && err.message.includes("No such checkout session")) {
      return NextResponse.json({ error: "Unknown checkout session" }, { status: 404 });
    }
    console.error("[billing/verify] failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Checkout verification failed" }, { status: 500 });
  }
}
