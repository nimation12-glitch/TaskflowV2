"use client";

import { loadStripe } from "@stripe/stripe-js";
import { EmbeddedCheckout, EmbeddedCheckoutProvider } from "@stripe/react-stripe-js";

// The publishable key is public by design (it ships in every browser bundle);
// the secret key never leaves the backend. Loaded once for the whole page.
const publishableKey = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;
const stripePromise = publishableKey ? loadStripe(publishableKey) : null;

/**
 * Stripe's secure card form, rendered inside our own /checkout page so the
 * customer never leaves Taskflow. Everything card-related — validation, 3DS,
 * error copy — is Stripe's iframe; we only decide where it sits and what the
 * page around it says.
 */
export function CheckoutForm({ clientSecret, sessionId }: { clientSecret: string; sessionId: string }) {
  if (!stripePromise) {
    return (
      <div className="rounded-md border border-warning/40 bg-warning/10 p-4 text-sm text-warning">
        Payments are temporarily unavailable — the checkout key isn&apos;t configured. Please try again shortly.
      </div>
    );
  }

  return (
    <EmbeddedCheckoutProvider
      stripe={stripePromise}
      options={{
        clientSecret,
        // Stripe redirects itself when `redirect_on_completion` is set
        // server-side; this is the belt-and-braces path if it ever doesn't.
        onComplete: () => {
          window.location.assign(`/checkout/complete?cs=${encodeURIComponent(sessionId)}`);
        },
      }}
    >
      <EmbeddedCheckout id="taskflow-checkout" />
    </EmbeddedCheckoutProvider>
  );
}
