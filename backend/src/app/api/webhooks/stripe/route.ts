/**
 * POST /api/webhooks/stripe — Stripe webhook receiver.
 *
 * SECURITY (spec §7):
 *  - Every delivered event MUST carry a valid Stripe signature. Validity is
 *    checked against STRIPE_WEBHOOK_SECRET via stripe.webhooks.constructEvent.
 *  - Missing signature header            → 400
 *  - Invalid signature / tampered body   → 400
 *  - Secret not configured               → 503 (refuse to apply unverified events)
 *  - Stripe not configured at all        → 503 (billing disabled, fail closed)
 *
 * There is NO simulated-event path. Test fixtures exist only inside the
 * isolated unit-test suite (which calls the fulfillment service directly).
 *
 * IDEMPOTENCY (§17): event ids are claimed in the StripeEvent table before
 * processing — duplicate deliveries return success without side effects.
 */
import { NextRequest, NextResponse } from "next/server";
import { serverEnv } from "@/server/env";
import { getStripe, claimStripeEvent, markStripeEventFailed } from "@/server/stripe";
import { applyStripeEvent } from "@/server/billing/fulfillment";

export async function POST(req: NextRequest) {
  if (!serverEnv.stripeSecretKey || !serverEnv.stripeWebhookSecret) {
    // Fail closed: without the shared secret we cannot distinguish a genuine
    // Stripe delivery from an attacker's payload. Never apply unverified events.
    console.error(
      "[stripe-webhook] refused: STRIPE_SECRET_KEY/STRIPE_WEBHOOK_SECRET not fully configured",
    );
    return NextResponse.json(
      { error: "Webhook processing is not configured; refusing unverified events" },
      { status: 503 },
    );
  }

  const rawBody = await req.text();
  const signature = req.headers.get("stripe-signature");
  if (!signature) {
    return NextResponse.json({ error: "Missing stripe-signature header" }, { status: 400 });
  }

  let event: { id: string; type: string; data: { object: Record<string, unknown> } };
  try {
    const stripe = await getStripe();
    // constructEventAsync: correct under WebCrypto runtimes (Bun/Workers)
    // and identical verification semantics to the sync variant.
    event = (await stripe.webhooks.constructEventAsync(
      rawBody,
      signature,
      serverEnv.stripeWebhookSecret!,
    )) as unknown as typeof event;
  } catch (err) {
    console.error(
      "[stripe-webhook] signature verification failed:",
      err instanceof Error ? err.message : err,
    );
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  if (!event?.id || !event?.type) {
    return NextResponse.json({ error: "Malformed event" }, { status: 400 });
  }

  // Claim the event id — duplicates exit here (§17).
  const claimed = await claimStripeEvent(event.id, event.type, rawBody);
  if (!claimed) {
    return NextResponse.json({ received: true, duplicate: true });
  }

  try {
    const summary = await applyStripeEvent({
      id: event.id,
      type: event.type,
      data: event.data as Record<string, unknown>,
    });
    console.log(`[stripe-webhook] ${event.type} (${event.id}): ${summary}`);
    return NextResponse.json({ received: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    await markStripeEventFailed(event.id, message);
    console.error(`[stripe-webhook] ${event.type} (${event.id}) FAILED: ${message}`);
    // 500 tells Stripe to retry; the claim row keeps us idempotent.
    return NextResponse.json({ error: "Processing failed" }, { status: 500 });
  }
}
