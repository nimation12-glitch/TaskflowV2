/**
 * Stripe integration — REAL billing only (spec §1–§4, §16, §17).
 *
 * There is no simulated mode. When STRIPE_SECRET_KEY is absent the billing
 * features fail closed (see src/server/startup.ts and the checkout routes):
 * production refuses to start, development endpoints return 503.
 *
 * WEBHOOK IDEMPOTENCY (§17): every verified event id is recorded in the
 * StripeEvent table before processing — duplicate deliveries are skipped.
 * Event application lives in src/server/billing/fulfillment.ts.
 */
import { db } from "@/lib/db";
import { serverEnv } from "@/server/env";
import type { Organization, User } from "@prisma/client";
import type Stripe from "stripe";

/** Billing mode exposed to the UI (spec §13): real Stripe live/test, or unconfigured. */
export type BillingMode = "live" | "test" | "unconfigured";

export function billingMode(): BillingMode {
  return serverEnv.stripeMode ?? "unconfigured";
}

/** Shared Stripe SDK client (lazy import keeps cold start lean). */
let stripeClient: Stripe | null = null;

export async function getStripe(): Promise<Stripe> {
  const key = serverEnv.stripeSecretKey;
  if (!key) {
    // Fail closed — never construct a fake billing client.
    throw new BillingUnavailableError("Stripe is not configured on this deployment");
  }
  if (!stripeClient) {
    const { default: Stripe } = await import("stripe");
    stripeClient = new Stripe(key);
  }
  return stripeClient;
}

/** Thrown by billing endpoints when Stripe configuration is missing (→ 503). */
export class BillingUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BillingUnavailableError";
  }
}

/** Idempotent webhook event guard. Returns false if already processed. */
export async function claimStripeEvent(eventId: string, type: string, payload: string): Promise<boolean> {
  try {
    await db.stripeEvent.create({ data: { id: eventId, type, payload, status: "PROCESSED" } });
    return true;
  } catch {
    // Unique constraint on id → already seen.
    return false;
  }
}

export async function markStripeEventFailed(eventId: string, error: string): Promise<void> {
  await db.stripeEvent
    .update({
      where: { id: eventId },
      data: { status: "FAILED", error },
    })
    .catch(() => undefined);
}

/**
 * Ensure the ORGANIZATION has a Stripe customer (spec §3). The individual
 * user is never the billing entity; the customer carries org metadata.
 */
export async function ensureOrgStripeCustomer(
  org: Organization,
  owner: Pick<User, "id" | "email" | "name">,
): Promise<string> {
  if (org.stripeCustomerId) {
    // Self-heal deleted customers (e.g. test-mode data resets).
    try {
      const existing = await getStripe().then((s) => s.customers.retrieve(org.stripeCustomerId!));
      if (!existing.deleted) return org.stripeCustomerId;
    } catch {
      /* fall through and recreate */
    }
  }
  const stripe = await getStripe();
  const customer = await stripe.customers.create({
    email: owner.email,
    name: org.name,
    metadata: {
      taskflowOrganizationId: org.id,
      taskflowOwnerUserId: owner.id,
    },
  });
  await db.organization.update({
    where: { id: org.id },
    data: { stripeCustomerId: customer.id },
  });
  return customer.id;
}

export async function nextInvoiceNumber(): Promise<string> {
  const count = await db.invoice.count();
  return `TF-${String(count + 1).padStart(6, "0")}`;
}

export async function createInvoice(opts: {
  organizationId: string;
  userId: string;
  description: string;
  amountMicros: number;
  status?: string;
  periodStart?: Date;
  periodEnd?: Date;
  stripeInvoiceId?: string;
  stripePaymentIntentId?: string;
  hostedUrl?: string;
}): Promise<{ id: string; number: string }> {
  // Reconciliation first: one TaskFlow invoice per Stripe invoice.
  if (opts.stripeInvoiceId) {
    const existing = await db.invoice.findUnique({ where: { stripeInvoiceId: opts.stripeInvoiceId } });
    if (existing) return { id: existing.id, number: existing.number };
  }
  const number = await nextInvoiceNumber();
  const invoice = await db.invoice.create({
    data: {
      organizationId: opts.organizationId,
      userId: opts.userId,
      number,
      description: opts.description,
      amountMicros: opts.amountMicros,
      status: opts.status ?? "PAID",
      periodStart: opts.periodStart,
      periodEnd: opts.periodEnd,
      stripeInvoiceId: opts.stripeInvoiceId,
      stripePaymentIntentId: opts.stripePaymentIntentId,
      hostedUrl: opts.hostedUrl,
    },
  });
  return { id: invoice.id, number };
}
