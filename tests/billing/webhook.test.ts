/// <reference types="bun-types" />
/**
 * Webhook security & idempotency (spec §7, §17):
 *   1. valid Stripe webhook  → processed, credits granted
 *   2. invalid signature     → 400, nothing applied
 *   3. missing signature     → 400, nothing applied
 *   4. duplicate webhook     → success response, NO repeated side effects
 *   5. signature from the wrong secret → 400
 *   6. live mode without webhook secret → 503 (refuses unverified events)
 *   7. no Stripe configuration          → 503 (fail closed)
 *
 * The route reads configuration through serverEnv getters at request time,
 * so env mutations below are observed by the already-imported handler.
 */
import { describe, test, expect, beforeAll } from "bun:test";
import { db } from "@/lib/db";
import { ensureSeedPlans, makeOrg, signedWebhookRequest, checkoutSessionCompletedEvent, stripeSignature } from "../helpers";
import { POST as webhookPOST } from "@/app/api/webhooks/stripe/route";

beforeAll(async () => {
  await ensureSeedPlans();
});

describe("stripe webhook security", () => {
  test("1. valid signed webhook is processed and grants credits exactly once", async () => {
    const { user, org } = await makeOrg("valid-webhook");
    const event = checkoutSessionCompletedEvent({
      sessionId: "cs_valid_webhook_1",
      purchaseType: "credits",
      organizationId: org.id,
      amountMicros: 10_000_000,
      packageLabel: "£10",
    });

    const res = await webhookPOST(signedWebhookRequest(event));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.received).toBe(true);

    const balance = await db.creditAccount.findFirst({ where: { userId: user.id } });
    expect(balance?.balanceMicros).toBe(10_000_000);

    const grant = await db.creditTransaction.findFirst({
      where: { uniqueGrantKey: "stripe_cs_cs_valid_webhook_1" },
    });
    expect(grant).not.toBeNull();
    expect(grant?.type).toBe("PURCHASE");
    expect(grant?.organizationId).toBe(org.id);

    // Ledger metadata carries the full Stripe reconciliation chain (§16/§18).
    const meta = JSON.parse(grant?.metadata ?? "{}");
    expect(meta.stripe_checkout_session_id).toBe("cs_valid_webhook_1");
    expect(meta.stripe_payment_intent_id).toBe("pi_cs_valid_webhook_1");
    expect(meta.stripe_event_id).toBe("evt_cs_valid_webhook_1");
    expect(meta.organization_id).toBe(org.id);

    // StripeEvent row records processed state.
    const stored = await db.stripeEvent.findUnique({ where: { id: "evt_cs_valid_webhook_1" } });
    expect(stored?.status).toBe("PROCESSED");

    // TaskFlow invoice mirrors the purchase.
    const invoice = await db.invoice.findFirst({ where: { organizationId: org.id } });
    expect(invoice).not.toBeNull();
    expect(invoice?.stripePaymentIntentId).toBe("pi_cs_valid_webhook_1");
  });

  test("2. invalid signature → 400 and nothing applied", async () => {
    const { user, org } = await makeOrg("bad-sig");
    const event = checkoutSessionCompletedEvent({
      sessionId: "cs_bad_sig_1",
      purchaseType: "credits",
      organizationId: org.id,
      amountMicros: 25_000_000,
      packageLabel: "£25",
    });
    const res = await webhookPOST(signedWebhookRequest(event, { signature: "t=1,v1=deadbeef" }));
    expect(res.status).toBe(400);

    const balance = await db.creditAccount.findFirst({ where: { userId: user.id } });
    expect(balance?.balanceMicros ?? 0).toBe(0);
    expect(await db.stripeEvent.findUnique({ where: { id: "evt_cs_bad_sig_1" } })).toBeNull();
  });

  test("3. missing signature header → 400 and nothing applied", async () => {
    const { user, org } = await makeOrg("no-sig");
    const event = checkoutSessionCompletedEvent({
      sessionId: "cs_no_sig_1",
      purchaseType: "credits",
      organizationId: org.id,
      amountMicros: 50_000_000,
      packageLabel: "£50",
    });
    const res = await webhookPOST(signedWebhookRequest(event, { signature: null }));
    expect(res.status).toBe(400);

    const balance = await db.creditAccount.findFirst({ where: { userId: user.id } });
    expect(balance?.balanceMicros ?? 0).toBe(0);
  });

  test("4. duplicate webhook delivery is acknowledged but never re-applied", async () => {
    const { user, org } = await makeOrg("dup-webhook");
    const event = checkoutSessionCompletedEvent({
      sessionId: "cs_dup_webhook_1",
      purchaseType: "credits",
      organizationId: org.id,
      amountMicros: 10_000_000,
      packageLabel: "£10",
    });

    const first = await webhookPOST(signedWebhookRequest({ ...event, id: "evt_dup_1" }));
    expect(first.status).toBe(200);

    const second = await webhookPOST(signedWebhookRequest({ ...event, id: "evt_dup_1" }));
    expect(second.status).toBe(200);
    expect((await second.json()).duplicate).toBe(true);

    const balance = await db.creditAccount.findFirst({ where: { userId: user.id } });
    expect(balance?.balanceMicros).toBe(10_000_000); // exactly one grant

    const invoices = await db.invoice.findMany({ where: { organizationId: org.id } });
    expect(invoices.length).toBe(1); // exactly one invoice
  });

  test("5. signature from the wrong secret is rejected (secret mismatch)", async () => {
    const { user, org } = await makeOrg("wrong-secret");
    const event = checkoutSessionCompletedEvent({
      sessionId: "cs_wrong_secret_1",
      purchaseType: "credits",
      organizationId: org.id,
      amountMicros: 10_000_000,
      packageLabel: "£10",
    });
    const payload = JSON.stringify(event);
    const attackerSignature = stripeSignature(payload, "whsec_attacker");
    const res = await webhookPOST(signedWebhookRequest(event, { signature: attackerSignature }));
    expect(res.status).toBe(400);
    const balance = await db.creditAccount.findFirst({ where: { userId: user.id } });
    expect(balance?.balanceMicros ?? 0).toBe(0);
  });
});

describe("webhook fail-closed configuration", () => {
  test("6. without STRIPE_WEBHOOK_SECRET the endpoint refuses ALL events (503)", async () => {
    const saved = process.env.STRIPE_WEBHOOK_SECRET;
    delete process.env.STRIPE_WEBHOOK_SECRET;
    try {
      const res = await webhookPOST(signedWebhookRequest({ id: "evt_x", type: "invoice.paid", data: { object: {} } }));
      expect(res.status).toBe(503);
    } finally {
      process.env.STRIPE_WEBHOOK_SECRET = saved;
    }
  });

  test("7. without STRIPE_SECRET_KEY billing is fail-closed (503)", async () => {
    const savedKey = process.env.STRIPE_SECRET_KEY;
    const savedSecret = process.env.STRIPE_WEBHOOK_SECRET;
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_WEBHOOK_SECRET;
    try {
      const res = await webhookPOST(signedWebhookRequest({ id: "evt_y", type: "invoice.paid", data: { object: {} } }));
      expect(res.status).toBe(503);
    } finally {
      process.env.STRIPE_SECRET_KEY = savedKey;
      process.env.STRIPE_WEBHOOK_SECRET = savedSecret;
    }
  });
});
