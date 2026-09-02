/**
 * Shared test helpers — plan seeding + Stripe signature fixtures.
 * Test payment fixtures are strictly isolated unit-test fixtures (spec §15):
 * they exercise the fulfillment service directly and never ship to runtime.
 */
import { createHmac } from "crypto";
import { db } from "@/lib/db";
import type { NextRequest } from "next/server";

/**
 * Split deployments: an ambient backend .env may set FRONTEND_BASE_URL
 * (the production frontend origin). Tests assert same-origin (localhost)
 * redirect shapes and bun applies .env AFTER the bunfig preload — so the
 * neutralisation must happen here, inside the module graph, before any
 * authjs module is imported by a test file.
 */
delete process.env.FRONTEND_BASE_URL;

export const WEBHOOK_SECRET = "whsec_test_signing_secret";

const POUNDS = (n: number) => Math.round(n * 1_000_000);

export async function ensureSeedPlans(): Promise<void> {
  await db.plan.upsert({
    where: { id: "free" },
    create: {
      id: "free",
      name: "Free",
      description: "Free plan",
      monthlyPriceMicros: 0,
      monthlyCreditMicros: POUNDS(2),
      rateLimitPerMinute: 20,
      priority: 0,
      maxConcurrency: 2,
      sortOrder: 1,
    },
    update: {},
  });
  await db.plan.upsert({
    where: { id: "pro" },
    create: {
      id: "pro",
      name: "Pro",
      description: "Pro plan",
      monthlyPriceMicros: POUNDS(30),
      monthlyCreditMicros: POUNDS(15),
      rateLimitPerMinute: 100,
      priority: 5,
      maxConcurrency: 10,
      canRentGpu: true,
      canBuyCredits: true,
      sortOrder: 2,
    },
    update: {},
  });
  await db.plan.upsert({
    where: { id: "max" },
    create: {
      id: "max",
      name: "Max",
      description: "Max plan",
      monthlyPriceMicros: POUNDS(90),
      monthlyCreditMicros: POUNDS(50),
      rateLimitPerMinute: 300,
      priority: 10,
      maxConcurrency: 30,
      canRentGpu: true,
      canBuyCredits: true,
      sortOrder: 3,
    },
    update: {},
  });
}

/** Build a genuine Stripe signature header for a payload (HMAC-SHA256). */
export function stripeSignature(payload: string, secret: string = WEBHOOK_SECRET, timestamp?: number): string {
  const t = timestamp ?? Math.floor(Date.now() / 1000);
  const v1 = createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex");
  return `t=${t},v1=${v1}`;
}

/** Build a signed webhook request for the webhook route handler. */
export function signedWebhookRequest(
  event: Record<string, unknown>,
  opts?: { signature?: string | null },
): NextRequest {
  const payload = JSON.stringify(event);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts?.signature !== null) {
    headers["stripe-signature"] = opts?.signature ?? stripeSignature(payload);
  }
  return new Request("http://localhost:3000/api/webhooks/stripe", {
    method: "POST",
    body: payload,
    headers,
  }) as unknown as NextRequest;
}

export function checkoutSessionCompletedEvent(opts: {
  sessionId: string;
  purchaseType: "subscription" | "credits";
  organizationId: string;
  plan?: string;
  amountMicros?: number;
  packageLabel?: string;
  subscriptionId?: string | null;
  customerId?: string;
  paymentIntentId?: string;
}) {
  return {
    id: `evt_${opts.sessionId}`,
    type: "checkout.session.completed",
    data: {
      object: {
        id: opts.sessionId,
        object: "checkout.session",
        mode: opts.purchaseType === "subscription" ? "subscription" : "payment",
        customer: opts.customerId ?? "cus_test_1",
        payment_status: "paid",
        status: "complete",
        payment_intent: opts.paymentIntentId ?? `pi_${opts.sessionId}`,
        subscription: opts.subscriptionId ?? null,
        metadata: {
          organization_id: opts.organizationId,
          plan: opts.plan ?? "",
          purchase_type: opts.purchaseType,
          ...(opts.purchaseType === "credits"
            ? { package: opts.packageLabel ?? "£10", amount_micros: String(opts.amountMicros ?? 10_000_000) }
            : {}),
        },
      },
    },
  };
}

export function invoicePaidEvent(opts: {
  invoiceId: string;
  subscriptionId: string;
  customerId?: string;
  periodStart: number; // unix seconds
  periodEnd: number;
  totalPence?: number;
}) {
  return {
    id: `evt_${opts.invoiceId}`,
    type: "invoice.paid",
    data: {
      object: {
        id: opts.invoiceId,
        object: "invoice",
        customer: opts.customerId ?? "cus_test_1",
        subscription: opts.subscriptionId,
        paid: true,
        total: opts.totalPence ?? 3000,
        currency: "gbp",
        period_start: opts.periodStart,
        period_end: opts.periodEnd,
        payment_intent: `pi_${opts.invoiceId}`,
      },
    },
  };
}

/**
 * Fresh org + owner for test isolation.
 *
 * NOTE: deliberately creates the org + OWNER membership DIRECTLY (not via
 * ensurePersonalOrg/createOrganization) so the Free-plan signup allowance is
 * NOT granted — billing tests assert deltas from a zero baseline.
 */
export async function makeOrg(suffix: string) {
  const user = await db.user.create({
    data: {
      email: `org-${suffix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@test-billing.dev`,
      name: `Test Owner ${suffix}`,
      // Test users are fully-verified accounts (beyond the verification
      // policy) — isolation/role tests exercise tenancy, not activation.
      status: "ACTIVE",
      emailVerifiedAt: new Date(),
      phoneVerifiedAt: new Date(),
      passwordCredential: { create: { passwordHash: "test:test" } },
    },
  });
  const org = await db.organization.create({
    data: {
      name: `Test Org ${suffix}`,
      slug: `test-${suffix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
      ownerUserId: user.id,
    },
  });
  await db.membership.create({
    data: { organizationId: org.id, userId: user.id, role: "OWNER" },
  });
  return { user, org };
}
