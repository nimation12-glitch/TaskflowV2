/**
 * Verified-Stripe-event fulfillment (spec §6, §7, §8, §12, §16).
 *
 * The ONLY paths that mutate billing state are:
 *   1. signature-verified webhooks (POST /api/webhooks/stripe), and
 *   2. checkout verification-on-return, which re-reads the Checkout Session
 *      from the Stripe API server-to-server.
 * Both funnel through this module. The frontend can never announce a
 * payment; every grant is anchored to a Stripe object we fetched/verified
 * and deduplicated via uniqueGrantKey (ledger) + StripeEvent (events).
 */
import { db } from "@/lib/db";
import { grantCredits } from "@/server/billing/ledger";
import { ensureOrgSubscription, mapStripeStatus, stripePeriodGrantKey } from "@/server/billing/subscription";
import { getStripe, createInvoice } from "@/server/stripe";
import { CREDIT_PACKAGES, MICRO_PER_POUND } from "@/lib/money";
import { serverEnv } from "@/server/env";
import type { Organization, User } from "@prisma/client";
import type Stripe from "stripe";

/** Stripe GBP amounts are pence; TaskFlow money is micro-GBP. 1p = 10_000µ. */
export function stripePenceToMicros(pence: number): number {
  return Math.round(pence * 10_000);
}

function microsToPence(micros: number): number {
  return Math.round(micros / 10_000);
}

export function planIdForStripePrice(priceId: string | null | undefined): string | null {
  if (!priceId) return null;
  if (priceId === serverEnv.stripePricePro) return "pro";
  if (priceId === serverEnv.stripePriceMax) return "max";
  return null;
}

/** Resolve + validate the organization a piece of Stripe metadata points at (§12). */
async function orgFromMetadata(
  metadata: Record<string, string> | null | undefined,
): Promise<(Organization & { owner: User }) | null> {
  const orgId = metadata?.organization_id ?? metadata?.taskflowOrganizationId;
  if (!orgId) return null;
  const org = await db.organization.findUnique({
    where: { id: orgId },
    include: { owner: true },
  });
  return org ?? null;
}

function assertOrgCustomer(org: Organization, customer: string | null | undefined): void {
  // Ownership check (§12): the checkout/webhook customer must be the org's
  // Stripe customer. We always create sessions with a customer attached.
  if (customer && org.stripeCustomerId && customer !== org.stripeCustomerId) {
    throw new Error(`ownership mismatch: customer ${customer} does not belong to organization ${org.id}`);
  }
}

// ── Credit pack fulfillment ───────────────────────────────────

export type CreditFulfillment = {
  orgId: string;
  userId: string;
  amountMicros: number;
  label: string;
  checkoutSessionId: string;
  paymentIntentId?: string | null;
  eventId?: string | null;
};

/**
 * Grant purchased credits + create the invoice record. Idempotent per
 * Checkout Session via uniqueGrantKey = stripe_cs_{sessionId} (§16, §17).
 */
export async function fulfillCreditPurchase(input: CreditFulfillment): Promise<string> {
  const amount = stripePenceToMicros(microsToPence(input.amountMicros)); // normalise to whole pence
  const pkg = CREDIT_PACKAGES.find((p) => p.micros === amount);
  if (!pkg) {
    // The amount must be one of the configured packages — never trust a
    // client-supplied number (§12). Checkout sessions are created with
    // package metadata server-side, so this only fires on tampering.
    throw new Error(`credit purchase amount ${amount} is not a configured package`);
  }

  const grant = await grantCredits({
    userId: input.userId,
    organizationId: input.orgId,
    amountMicros: amount,
    type: "PURCHASE",
    description: `Stripe credit purchase ${pkg.label}`,
    referenceId: input.paymentIntentId ?? input.checkoutSessionId,
    uniqueGrantKey: `stripe_cs_${input.checkoutSessionId}`,
    metadata: {
      stripe_payment_intent_id: input.paymentIntentId ?? null,
      stripe_checkout_session_id: input.checkoutSessionId,
      stripe_event_id: input.eventId ?? null,
      organization_id: input.orgId,
      package: pkg.label,
      source: "stripe",
    },
  });
  if (!grant.granted) {
    return `credit purchase ${input.checkoutSessionId} already fulfilled — skipped`;
  }

  await createInvoice({
    organizationId: input.orgId,
    userId: input.userId,
    description: `Credit purchase ${pkg.label}`,
    amountMicros: amount,
    stripePaymentIntentId: input.paymentIntentId ?? undefined,
  });
  return `credits granted: £${(amount / MICRO_PER_POUND).toFixed(2)} (session ${input.checkoutSessionId})`;
}

// ── Subscription fulfillment ──────────────────────────────────

export type SubscriptionFulfillment = {
  org: Pick<Organization, "id">; // owner + slug are re-read server-side
  planId: string;
  checkoutSessionId: string;
  stripeSubscriptionId: string | null;
  stripeCustomerId: string | null;
  stripePriceId: string | null;
  eventId?: string | null;
};

/**
 * Activate a subscription from a completed Checkout Session. The Stripe
 * subscription is retrieved server-side for the authoritative period +
 * status; the first monthly allowance is granted once per Stripe period.
 */
export async function fulfillSubscriptionCheckout(input: SubscriptionFulfillment): Promise<string> {
  // SESSION-LEVEL IDEMPOTENCY: a checkout session is fulfilled at most once,
  // no matter how many times the webhook or verification-on-return fires.
  const already = await db.subscription.findUnique({
    where: { stripeCheckoutSessionId: input.checkoutSessionId },
  });
  if (already) {
    return `subscription checkout ${input.checkoutSessionId} already fulfilled — skipped`;
  }

  // Re-read the org WITH its owner — callers may pass a bare organization.
  const org = await db.organization.findUnique({
    where: { id: input.org.id },
    include: { owner: true },
  });
  if (!org) throw new Error(`Unknown organization: ${input.org.id}`);
  const orgWithOwner = org;

  const plan = await db.plan.findUnique({ where: { id: input.planId } });
  if (!plan) throw new Error(`Unknown plan: ${input.planId}`);

  let periodStart = new Date();
  let periodEnd = new Date(periodStart.getTime() + 30 * 24 * 3600 * 1000);
  let status = "ACTIVE";
  let invoicePaidAmount: number | null = null;
  let stripeInvoiceId: string | undefined;
  let hostedUrl: string | undefined;

  if (input.stripeSubscriptionId) {
    const stripe = await getStripe();
    const remote = (await stripe.subscriptions.retrieve(input.stripeSubscriptionId)) as unknown as {
      status: string;
      current_period_start?: number;
      current_period_end?: number;
      items?: { data?: Array<{ current_period_start?: number; current_period_end?: number }> };
      latest_invoice?: string | null;
    };
    status = mapStripeStatus(remote.status);
    // Stripe API 2025-03-31.basil moved current_period_* into subscription
    // items; older versions keep them top-level. Read both.
    const item = remote.items?.data?.[0];
    const startUnix = remote.current_period_start ?? item?.current_period_start;
    const endUnix = remote.current_period_end ?? item?.current_period_end;
    if (startUnix) periodStart = new Date(startUnix * 1000);
    if (endUnix) periodEnd = new Date(endUnix * 1000);
    if (remote.latest_invoice && typeof remote.latest_invoice === "string") {
      const inv = (await stripe.invoices.retrieve(remote.latest_invoice as string)) as unknown as {
        paid: boolean;
        total: number;
        id: string;
        hosted_invoice_url?: string;
      };
      if (inv.paid) {
        invoicePaidAmount = stripePenceToMicros(inv.total);
        stripeInvoiceId = inv.id;
        hostedUrl = typeof inv.hosted_invoice_url === "string" ? inv.hosted_invoice_url : undefined;
      }
    }
  }

  await ensureOrgSubscription({
    organizationId: orgWithOwner.id,
    userId: orgWithOwner.owner.id,
    planId: input.planId,
    status,
    stripeSubscriptionId: input.stripeSubscriptionId,
    stripePriceId: input.stripePriceId,
    stripeCustomerId: input.stripeCustomerId,
    stripeCheckoutSessionId: input.checkoutSessionId,
    grantCreditsNow: true,
    periodStart,
    periodEnd,
  });

  await createInvoice({
    organizationId: orgWithOwner.id,
    userId: orgWithOwner.owner.id,
    description: `${plan.name} plan subscription (monthly)`,
    amountMicros: invoicePaidAmount ?? plan.monthlyPriceMicros,
    periodStart,
    periodEnd,
    stripeInvoiceId,
    hostedUrl,
  });
  return `subscription activated: ${input.planId} for org ${orgWithOwner.slug} (session ${input.checkoutSessionId})`;
}

// ── Webhook event application ─────────────────────────────────

export type WebhookEventData = {
  id: string;
  type: string;
  data: Record<string, unknown>;
};

/** Dispatch a verified Stripe event. Returns a human summary for logs. */
export async function applyStripeEvent(event: WebhookEventData): Promise<string> {
  const obj = (event.data.object ?? {}) as Record<string, any>;
  const metadata = (obj.metadata ?? {}) as Record<string, string>;

  switch (event.type) {
    case "checkout.session.completed": {
      const purchaseType = metadata.purchase_type ?? metadata.kind ?? "";
      const org = await orgFromMetadata(metadata);
      if (!org) return "checkout.session.completed without a resolvable organization_id — skipped";
      assertOrgCustomer(org, typeof obj.customer === "string" ? obj.customer : null);

      const checkoutSessionId = String(obj.id ?? "");
      const paymentIntentId = typeof obj.payment_intent === "string" ? obj.payment_intent : null;

      if (purchaseType === "credits") {
        const amountMicros = Number(metadata.amount_micros ?? metadata.amountMicros ?? 0);
        return fulfillCreditPurchase({
          orgId: org.id,
          userId: org.owner.id,
          amountMicros,
          label: metadata.package ?? "",
          checkoutSessionId,
          paymentIntentId,
          eventId: event.id,
        });
      }

      if (purchaseType === "subscription") {
        const planId = planIdForStripePrice(metadata.stripe_price_id) ?? metadata.plan ?? null;
        if (!planId || !["pro", "max"].includes(planId)) {
          return `checkout.session.completed: unrecognised plan (${planId}) — skipped`;
        }
        const stripeSubscriptionId = typeof obj.subscription === "string" ? obj.subscription : null;
        return fulfillSubscriptionCheckout({
          org,
          planId,
          checkoutSessionId,
          stripeSubscriptionId,
          stripeCustomerId: typeof obj.customer === "string" ? obj.customer : null,
          stripePriceId: metadata.stripe_price_id ?? null,
          eventId: event.id,
        });
      }

      return `checkout.session.completed: unknown purchase_type '${purchaseType}' — skipped`;
    }

    case "invoice.paid": {
      const stripeSubscriptionId = typeof obj.subscription === "string" ? obj.subscription : null;
      if (!stripeSubscriptionId) return "invoice.paid without subscription — skipped";

      const sub = await db.subscription.findUnique({
        where: { stripeSubscriptionId },
        include: { plan: true },
      });
      if (!sub) return "invoice.paid: no matching TaskFlow subscription — skipped";

      // Authoritative period from the invoice (unix seconds).
      const periodStart = obj.period_start ? new Date(Number(obj.period_start) * 1000) : new Date();
      const periodEnd = obj.period_end ? new Date(Number(obj.period_end) * 1000) : new Date(periodStart.getTime() + 30 * 24 * 3600 * 1000);
      const grantKey = stripePeriodGrantKey(stripeSubscriptionId, periodStart);

      // Payment succeeded → the period is legitimate (§8): sync state + grant.
      await db.subscription.update({
        where: { id: sub.id },
        data: {
          status: sub.status === "TRIALING" ? "TRIALING" : "ACTIVE",
          pastDueAt: null,
          currentPeriodStart: periodStart,
          currentPeriodEnd: periodEnd,
        },
      });

      if (sub.plan.monthlyCreditMicros > 0) {
        const grant = await grantCredits({
          userId: sub.userId,
          organizationId: sub.organizationId,
          amountMicros: sub.plan.monthlyCreditMicros,
          type: "MONTHLY_GRANT",
          description: `Monthly ${sub.plan.name} plan credits`,
          periodStart,
          periodEnd,
          uniqueGrantKey: grantKey,
          metadata: {
            stripe_invoice_id: String(obj.id ?? ""),
            stripe_subscription_id: stripeSubscriptionId,
            stripe_payment_intent_id: typeof obj.payment_intent === "string" ? obj.payment_intent : null,
            stripe_event_id: event.id,
            organization_id: sub.organizationId,
            source: "stripe",
          },
        });
        if (!grant.granted) {
          await createTaskflowInvoiceFromStripeInvoice(obj, sub);
          return `invoice.paid ${String(obj.id)}: allowance for period already granted — skipped`;
        }
      }

      const invoice = await createTaskflowInvoiceFromStripeInvoice(obj, sub);
      return `invoice.paid ${invoice.number}: ${sub.plan.name} allowance granted for period ${periodStart.toISOString().slice(0, 10)}`;
    }

    case "invoice.payment_failed": {
      const stripeSubscriptionId = typeof obj.subscription === "string" ? obj.subscription : null;
      const stripeCustomerId = typeof obj.customer === "string" ? obj.customer : null;
      const sub = stripeSubscriptionId
        ? await db.subscription.findUnique({ where: { stripeSubscriptionId } })
        : stripeCustomerId
          ? await db.subscription.findFirst({ where: { stripeCustomerId } })
          : null;
      if (!sub) return "invoice.payment_failed: no matching subscription — skipped";

      // §10: no new credits; mark the org's subscription; grace window starts.
      const now = new Date();
      await db.subscription.update({
        where: { id: sub.id },
        data: { status: "PAST_DUE", pastDueAt: sub.pastDueAt ?? now },
      });
      return `subscription ${sub.id} marked PAST_DUE (grace window started, org ${sub.organizationId})`;
    }

    case "customer.subscription.updated": {
      const stripeSubscriptionId = typeof obj.id === "string" ? obj.id : null;
      if (!stripeSubscriptionId) return "customer.subscription.updated: no id — skipped";
      const sub = await db.subscription.findUnique({ where: { stripeSubscriptionId } });
      if (!sub) return "customer.subscription.updated: no matching subscription — skipped";

      const remoteStatus = String(obj.status ?? "active");
      const newStatus = mapStripeStatus(remoteStatus);
      const items = obj.items as { data?: Array<{ price?: { id?: string } }> } | undefined;
      const priceId = items?.data?.[0]?.price?.id ?? null;
      const newPlanId = planIdForStripePrice(priceId);

      const periodStartUnix = obj.current_period_start as number | undefined;
      const periodEndUnix = obj.current_period_end as number | undefined;

      const enteringPastDue = newStatus === "PAST_DUE" && sub.status !== "PAST_DUE";
      const leavingProblem = newStatus === "ACTIVE" || newStatus === "TRIALING";

      const updated = await db.subscription.update({
        where: { id: sub.id },
        data: {
          status: newStatus,
          cancelAtPeriodEnd: Boolean(obj.cancel_at_period_end),
          pastDueAt: enteringPastDue ? new Date() : leavingProblem ? null : sub.pastDueAt,
          stripePriceId: priceId ?? sub.stripePriceId,
          ...(newPlanId ? { planId: newPlanId } : {}),
          ...(periodStartUnix ? { currentPeriodStart: new Date(periodStartUnix * 1000) } : {}),
          ...(periodEndUnix ? { currentPeriodEnd: new Date(periodEndUnix * 1000) } : {}),
        },
      });
      return `subscription ${updated.id} updated: status ${newStatus}, plan ${updated.planId}${newPlanId ? " (price-mapped)" : ""}`;
    }

    case "customer.subscription.deleted": {
      const stripeSubscriptionId = typeof obj.id === "string" ? obj.id : null;
      if (!stripeSubscriptionId) return "customer.subscription.deleted: no id — skipped";
      const sub = await db.subscription.findUnique({ where: { stripeSubscriptionId } });
      if (!sub) return "customer.subscription.deleted: no matching subscription — skipped";

      // §11: sync cancellation, stop future paid allowance, keep all history.
      await db.subscription.update({
        where: { id: sub.id },
        data: { status: "CANCELED", cancelAtPeriodEnd: false },
      });
      return `subscription ${sub.id} canceled — paid allowance stops; history preserved (org ${sub.organizationId})`;
    }

    default:
      return `${event.type}: acknowledged, no state change`;
    }
}

/** Upsert the TaskFlow invoice mirror of a Stripe invoice (reconciliation §18). */
async function createTaskflowInvoiceFromStripeInvoice(
  obj: Record<string, any>,
  sub: { organizationId: string; userId: string; plan: { name: string } },
): Promise<{ id: string; number: string }> {
  const periodStart = obj.period_start ? new Date(Number(obj.period_start) * 1000) : undefined;
  const periodEnd = obj.period_end ? new Date(Number(obj.period_end) * 1000) : undefined;
  return createInvoice({
    organizationId: sub.organizationId,
    userId: sub.userId,
    description: `${sub.plan.name} plan subscription (Stripe invoice ${String(obj.id ?? "")})`,
    amountMicros: stripePenceToMicros(Number(obj.total ?? 0)),
    status: obj.paid ? "PAID" : "OPEN",
    periodStart,
    periodEnd,
    stripeInvoiceId: typeof obj.id === "string" ? obj.id : undefined,
    stripePaymentIntentId: typeof obj.payment_intent === "string" ? obj.payment_intent : undefined,
    hostedUrl: typeof obj.hosted_invoice_url === "string" ? obj.hosted_invoice_url : undefined,
  });
}
