/**
 * Shape returned by GET /billing/checkout/session — everything the branded
 * /checkout page needs to render the order summary and mount Stripe's
 * embedded card form. Money is micro-GBP like the rest of the product.
 */
export type CheckoutSessionSummary = {
  session_id: string;
  /** Null only for a session Stripe won't hand a secret to (expired/foreign). */
  client_secret: string | null;
  mode: string | null;
  status: string | null;
  payment_status: string | null;
  currency: string | null;
  total_micros: number;
  title: string;
  items: { name: string; amount_micros: number }[];
  purchase_type: string;
  plan: string | null;
};
