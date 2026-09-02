/// <reference types="bun-types" />
/**
 * Checkout fulfillment & subscription lifecycle (spec §4–§6, §8–§11, §19):
 *   5.  successful Pro checkout      → £15 monthly allowance, ACTIVE
 *   6.  successful Max checkout      → £50 monthly allowance
 *   7.  successful £10  purchase
 *   8.  successful £25  purchase
 *   9.  successful £50  purchase
 *   10. successful £100 purchase
 *   11. payment failure              → PAST_DUE + grace semantics, no credits
 *   12. subscription cancellation    → CANCELED, no entitlement, history kept
 *   13. subscription update          → Stripe status synchronised
 *   14. duplicate monthly credit event → exactly one grant
 */
import { describe, test, expect, beforeAll } from "bun:test";
import { db } from "@/lib/db";
import { ensureSeedPlans, makeOrg, invoicePaidEvent } from "../helpers";
import {
  applyStripeEvent,
  fulfillCreditPurchase,
  fulfillSubscriptionCheckout,
} from "@/server/billing/fulfillment";
import { ensureOrgSubscription, planEntitled, PAST_DUE_GRACE_DAYS } from "@/server/billing/subscription";

const POUNDS = (n: number) => Math.round(n * 1_000_000);

beforeAll(async () => {
  await ensureSeedPlans();
});

describe("subscription checkouts (real Stripe prices)", () => {
  test("5. successful Pro checkout → ACTIVE subscription + £15 allowance", async () => {
    const { user, org } = await makeOrg("pro-checkout");
    const summary = await fulfillSubscriptionCheckout({
      org,
      planId: "pro",
      checkoutSessionId: "cs_pro_1",
      stripeSubscriptionId: null, // non-network path; Stripe retrieve happens live
      stripeCustomerId: "cus_pro_1",
      stripePriceId: "price_pro_test",
    });
    expect(summary).toContain("pro");

    const sub = await db.subscription.findUnique({ where: { organizationId: org.id } });
    expect(sub?.planId).toBe("pro");
    expect(sub?.status).toBe("ACTIVE");
    expect(sub?.stripeCustomerId).toBe("cus_pro_1");
    expect(sub?.stripeCheckoutSessionId).toBe("cs_pro_1");

    const balance = await db.creditAccount.findUnique({ where: { userId: user.id, organizationId: org.id } });
    expect(balance?.balanceMicros).toBe(POUNDS(15)); // §8: Pro grants £15/month

    // The allowance is stored as a single dedupe-able grant. (With a real
    // Stripe subscription the key is stripe_sub_{id}_{period}; the non-network
    // path here keys it per signup session.)
    const grant = await db.creditTransaction.findFirst({
      where: { organizationId: org.id, type: "MONTHLY_GRANT" },
    });
    expect(grant?.amountMicros).toBe(POUNDS(15));
    expect(grant?.uniqueGrantKey).not.toBeNull();
  });

  test("6. successful Max checkout → ACTIVE subscription + £50 allowance", async () => {
    const { user, org } = await makeOrg("max-checkout");
    await fulfillSubscriptionCheckout({
      org,
      planId: "max",
      checkoutSessionId: "cs_max_1",
      stripeSubscriptionId: null,
      stripeCustomerId: "cus_max_1",
      stripePriceId: "price_max_test",
    });
    const balance = await db.creditAccount.findUnique({ where: { userId: user.id, organizationId: org.id } });
    expect(balance?.balanceMicros).toBe(POUNDS(50)); // §8: Max grants £50/month
  });

  test("5b. re-verifying the same Pro checkout session grants nothing extra", async () => {
    const { user, org } = await makeOrg("pro-checkout-dup");
    await fulfillSubscriptionCheckout({
      org,
      planId: "pro",
      checkoutSessionId: "cs_pro_dup",
      stripeSubscriptionId: null,
      stripeCustomerId: "cus_pro_dup",
      stripePriceId: "price_pro_test",
    });
    // Webhook retry of the same checkout.session.completed
    await applyStripeEvent({
      id: "evt_pro_dup_1",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_pro_dup",
          customer: "cus_pro_dup",
          subscription: null,
          metadata: {
            organization_id: org.id,
            plan: "pro",
            purchase_type: "subscription",
          },
        },
      },
    });
    const balance = await db.creditAccount.findUnique({ where: { userId: user.id, organizationId: org.id } });
    expect(balance?.balanceMicros).toBe(POUNDS(15)); // still exactly one allowance
  });
});

describe("credit pack purchases (real Stripe prices)", () => {
  const packs: Array<[string, number, string]> = [
    ["£10", POUNDS(10), "7."],
    ["£25", POUNDS(25), "8."],
    ["£50", POUNDS(50), "9."],
    ["£100", POUNDS(100), "10."],
  ];

  for (const [label, micros] of packs) {
    test(`purchase of ${label} credits grants exactly ${label}`, async () => {
      const { user, org } = await makeOrg(`pack${micros}`);
      const sessionId = `cs_pack_${micros}`;
      const summary = await fulfillCreditPurchase({
        orgId: org.id,
        userId: user.id,
        amountMicros: micros,
        label,
        checkoutSessionId: sessionId,
        paymentIntentId: `pi_${sessionId}`,
        eventId: `evt_${sessionId}`,
      });
      expect(summary).toContain("credits granted");

      const balance = await db.creditAccount.findUnique({ where: { userId: user.id, organizationId: org.id } });
      expect(balance?.balanceMicros).toBe(micros);

      const grant = await db.creditTransaction.findFirst({ where: { uniqueGrantKey: `stripe_cs_${sessionId}` } });
      expect(grant?.amountMicros).toBe(micros);
      expect(grant?.type).toBe("PURCHASE");
    });
  }

  test("an amount that is not a configured package is rejected (tamper guard)", async () => {
    const { user, org } = await makeOrg("tamper");
    expect(
      fulfillCreditPurchase({
        orgId: org.id,
        userId: user.id,
        amountMicros: 7_333_333,
        label: "£7.33",
        checkoutSessionId: "cs_tamper_1",
      }),
    ).rejects.toThrow("not a configured package");
    const balance = await db.creditAccount.findUnique({ where: { userId: user.id, organizationId: org.id } });
    expect(balance?.balanceMicros ?? 0).toBe(0);
  });
});

describe("payment failure & grace (spec §10)", () => {
  test("11. invoice.payment_failed marks PAST_DUE, starts grace, grants nothing", async () => {
    const { user, org } = await makeOrg("payment-failed");
    await ensureOrgSubscription({
      organizationId: org.id,
      userId: user.id,
      planId: "pro",
      status: "ACTIVE",
      stripeSubscriptionId: "sub_payfail_1",
      grantCreditsNow: true,
    });
    const balanceBefore = (await db.creditAccount.findUnique({ where: { userId: user.id, organizationId: org.id } }))!.balanceMicros;

    const summary = await applyStripeEvent({
      id: "evt_payfail_1",
      type: "invoice.payment_failed",
      data: { object: { id: "in_payfail_1", subscription: "sub_payfail_1", customer: null } },
    });
    expect(summary).toContain("PAST_DUE");

    const sub = await db.subscription.findUnique({ where: { organizationId: org.id } });
    expect(sub?.status).toBe("PAST_DUE");
    expect(sub?.pastDueAt).not.toBeNull();

    // No new credits were granted.
    const balanceAfter = (await db.creditAccount.findUnique({ where: { userId: user.id, organizationId: org.id } }))!.balanceMicros;
    expect(balanceAfter).toBe(balanceBefore);

    // Within the grace window entitlement continues…
    expect(planEntitled("PAST_DUE", sub?.pastDueAt)).toBe(true);
    // …but after the configured grace it is removed (never silently kept).
    const expired = new Date(Date.now() - (PAST_DUE_GRACE_DAYS + 1) * 24 * 3600 * 1000);
    expect(planEntitled("PAST_DUE", expired)).toBe(false);
    // PAYMENT_FAILED / CANCELED / INCOMPLETE never entitle.
    expect(planEntitled("PAYMENT_FAILED", null)).toBe(false);
    expect(planEntitled("CANCELED", null)).toBe(false);
    expect(planEntitled("INCOMPLETE", null)).toBe(false);
    // TRIALING / ACTIVE entitle.
    expect(planEntitled("TRIALING", null)).toBe(true);
    expect(planEntitled("ACTIVE", null)).toBe(true);
  });
});

describe("cancellation (spec §11)", () => {
  test("12. subscription.deleted → CANCELED, no entitlement, history preserved", async () => {
    const { user, org } = await makeOrg("canceled");
    await ensureOrgSubscription({
      organizationId: org.id,
      userId: user.id,
      planId: "pro",
      status: "ACTIVE",
      stripeSubscriptionId: "sub_cancel_1",
      grantCreditsNow: true,
    });
    const txCountBefore = await db.creditTransaction.count({ where: { organizationId: org.id } });

    await applyStripeEvent({
      id: "evt_cancel_1",
      type: "customer.subscription.deleted",
      data: { object: { id: "sub_cancel_1", status: "canceled" } },
    });

    const sub = await db.subscription.findUnique({ where: { organizationId: org.id } });
    expect(sub?.status).toBe("CANCELED");
    expect(planEntitled(sub!.status, sub!.pastDueAt)).toBe(false);

    // Historical usage/billing data is never deleted on cancellation.
    const txCountAfter = await db.creditTransaction.count({ where: { organizationId: org.id } });
    expect(txCountAfter).toBe(txCountBefore);
  });
});

describe("subscription state synchronisation (spec §9)", () => {
  test("13. customer.subscription.updated maps Stripe statuses correctly", async () => {
    const { user, org } = await makeOrg("sync");
    await ensureOrgSubscription({
      organizationId: org.id,
      userId: user.id,
      planId: "pro",
      status: "ACTIVE",
      stripeSubscriptionId: "sub_sync_1",
      stripePriceId: "price_pro_old",
      grantCreditsNow: true,
    });

    // past_due → PAST_DUE
    await applyStripeEvent({
      id: "evt_sync_1",
      type: "customer.subscription.updated",
      data: { object: { id: "sub_sync_1", status: "past_due", cancel_at_period_end: false, items: { data: [{ price: { id: "price_pro_old" } }] } } },
    });
    let sub = await db.subscription.findUnique({ where: { organizationId: org.id } });
    expect(sub?.status).toBe("PAST_DUE");
    expect(sub?.pastDueAt).not.toBeNull();

    // unpaid → PAYMENT_FAILED
    await applyStripeEvent({
      id: "evt_sync_2",
      type: "customer.subscription.updated",
      data: { object: { id: "sub_sync_1", status: "unpaid", cancel_at_period_end: false } },
    });
    sub = await db.subscription.findUnique({ where: { organizationId: org.id } });
    expect(sub?.status).toBe("PAYMENT_FAILED");

    // trialing → TRIALING (problem flags cleared)
    await applyStripeEvent({
      id: "evt_sync_3",
      type: "customer.subscription.updated",
      data: { object: { id: "sub_sync_1", status: "trialing", cancel_at_period_end: false } },
    });
    sub = await db.subscription.findUnique({ where: { organizationId: org.id } });
    expect(sub?.status).toBe("TRIALING");
    expect(sub?.pastDueAt).toBeNull();

    // incomplete → INCOMPLETE
    await applyStripeEvent({
      id: "evt_sync_4",
      type: "customer.subscription.updated",
      data: { object: { id: "sub_sync_1", status: "incomplete", cancel_at_period_end: false } },
    });
    sub = await db.subscription.findUnique({ where: { organizationId: org.id } });
    expect(sub?.status).toBe("INCOMPLETE");

    // active with a NEW price → plan remapped from the configured price env vars
    process.env.STRIPE_PRICE_PRO = "price_pro_mapped";
    try {
      await applyStripeEvent({
        id: "evt_sync_5",
        type: "customer.subscription.updated",
        data: { object: { id: "sub_sync_1", status: "active", cancel_at_period_end: false, items: { data: [{ price: { id: "price_pro_mapped" } }] } } },
      });
      sub = await db.subscription.findUnique({ where: { organizationId: org.id } });
      expect(sub?.status).toBe("ACTIVE");
      expect(sub?.planId).toBe("pro");
      expect(sub?.stripePriceId).toBe("price_pro_mapped");
    } finally {
      delete process.env.STRIPE_PRICE_PRO;
    }
  });
});

describe("monthly allowance idempotency (spec §8, §17)", () => {
  test("14. the same subscription period is never granted twice (webhook retries, cross-path)", async () => {
    const { user, org } = await makeOrg("monthly-dup");
    const periodStart = new Date("2026-01-01T00:00:00Z");
    const periodEnd = new Date("2026-01-31T00:00:00Z");

    await ensureOrgSubscription({
      organizationId: org.id,
      userId: user.id,
      planId: "pro",
      status: "ACTIVE",
      stripeSubscriptionId: "sub_monthly_1",
      grantCreditsNow: true,
      periodStart,
      periodEnd,
    });

    const first = await applyStripeEvent(
      invoicePaidEvent({
        invoiceId: "in_monthly_1",
        subscriptionId: "sub_monthly_1",
        periodStart: Math.floor(periodStart.getTime() / 1000),
        periodEnd: Math.floor(periodEnd.getTime() / 1000),
      }),
    );
    const second = await applyStripeEvent(
      invoicePaidEvent({
        invoiceId: "in_monthly_1",
        subscriptionId: "sub_monthly_1",
        periodStart: Math.floor(periodStart.getTime() / 1000),
        periodEnd: Math.floor(periodEnd.getTime() / 1000),
      }),
    );

    // The invoice.paid for the SAME period as the signup grant dedupes.
    expect(first + second).toContain("already granted");

    // A DIFFERENT period grants exactly once.
    const nextStart = new Date("2026-02-01T00:00:00Z");
    const nextEnd = new Date("2026-02-28T00:00:00Z");
    await applyStripeEvent(
      invoicePaidEvent({
        invoiceId: "in_monthly_2",
        subscriptionId: "sub_monthly_1",
        periodStart: Math.floor(nextStart.getTime() / 1000),
        periodEnd: Math.floor(nextEnd.getTime() / 1000),
      }),
    );

    const monthlyGrants = await db.creditTransaction.findMany({
      where: { organizationId: org.id, type: "MONTHLY_GRANT" },
    });
    // one signup-period grant (period 1) + one renewal grant (period 2) — never duplicates
    expect(monthlyGrants.length).toBe(2);

    const balance = await db.creditAccount.findUnique({ where: { userId: user.id, organizationId: org.id } });
    expect(balance?.balanceMicros).toBe(POUNDS(30)); // £15 x 2 periods
  });

  test("14b. webhook retries of invoice.paid are fully idempotent", async () => {
    const { user, org } = await makeOrg("invoice-dup");
    const periodStart = new Date("2026-03-01T00:00:00Z");
    await ensureOrgSubscription({
      organizationId: org.id,
      userId: user.id,
      planId: "max",
      status: "ACTIVE",
      stripeSubscriptionId: "sub_invoice_dup",
      grantCreditsNow: false, // isolate: only the invoice.paid path grants
    });
    // Force the first invoice.paid to own the grant for this period.
    const first = await applyStripeEvent(
      invoicePaidEvent({
        invoiceId: "in_dup_a",
        subscriptionId: "sub_invoice_dup",
        periodStart: Math.floor(periodStart.getTime() / 1000),
        periodEnd: Math.floor((periodStart.getTime() + 30 * 86400_000) / 1000),
      }),
    );
    const retry = await applyStripeEvent(
      invoicePaidEvent({
        invoiceId: "in_dup_a",
        subscriptionId: "sub_invoice_dup",
        periodStart: Math.floor(periodStart.getTime() / 1000),
        periodEnd: Math.floor((periodStart.getTime() + 30 * 86400_000) / 1000),
      }),
    );
    expect(first).toContain("granted");
    expect(retry).toContain("already granted");

    const grants = await db.creditTransaction.findMany({ where: { organizationId: org.id, type: "MONTHLY_GRANT" } });
    expect(grants.length).toBe(1);
    expect((await db.creditAccount.findUnique({ where: { userId: user.id, organizationId: org.id } }))!.balanceMicros).toBe(POUNDS(50));
  });
});
