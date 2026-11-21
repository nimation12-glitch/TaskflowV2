import Link from "next/link";
import { redirect } from "next/navigation";
import { CheckCircle2, XCircle } from "lucide-react";
import { auth } from "@/auth";
import { backendJson } from "@/lib/backend-client";
import type { CheckoutSessionSummary } from "@/lib/checkout-types";
import { formatGbp } from "@/lib/utils";
import { LogoWordmark } from "@/components/logo-mark";
import { Button } from "@/components/ui/button";

export const metadata = { title: "Payment — TaskFlow" };

/**
 * Where Stripe drops the customer after an in-app payment finishes
 * (`return_url` on every checkout session). The webhook is what actually
 * credits the account — this page only reports, so a slow or failed render
 * here can never double-charge or lose a payment.
 */
export default async function CheckoutCompletePage({
  searchParams,
}: {
  searchParams: { cs?: string; redirect_status?: string };
}) {
  const cs = searchParams.cs?.trim() ?? "";
  const redirectStatus = searchParams.redirect_status;

  const session = await auth();
  if (!session?.user?.id) {
    const callback = cs ? `/checkout/complete?cs=${encodeURIComponent(cs)}` : "/checkout/complete";
    redirect(`/login?callbackUrl=${encodeURIComponent(callback)}`);
  }

  let summary: CheckoutSessionSummary | null = null;
  if (cs) {
    try {
      summary = await backendJson<CheckoutSessionSummary>(
        `/billing/checkout/session?session_id=${encodeURIComponent(cs)}`
      );
    } catch {
      summary = null;
    }
  }

  const paid =
    summary?.payment_status === "paid" ||
    summary?.payment_status === "no_payment_required" ||
    redirectStatus === "succeeded";
  const failed = redirectStatus === "failed" || (summary != null && summary.payment_status === "unpaid" && !paid);

  const heading = paid ? "Payment confirmed" : failed ? "Payment not completed" : "Payment processing";
  const body = paid
    ? "Your payment has been received. It can take a few seconds for the credit or plan change to show up."
    : failed
      ? "Your card wasn't charged. You can head back and try the payment again."
      : "We're waiting on confirmation from your bank. This usually resolves within a few seconds — check your Billing page in a moment.";

  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-background px-4 py-10">
      <div className="w-full max-w-md rounded-xl border border-border bg-card p-8 text-center">
        <div className="mb-6 flex justify-center">
          <LogoWordmark size={26} />
        </div>

        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-muted">
          {paid ? (
            <CheckCircle2 className="h-6 w-6 text-success" />
          ) : failed ? (
            <XCircle className="h-6 w-6 text-danger" />
          ) : (
            <span className="h-5 w-5 animate-spin rounded-full border-2 border-border border-t-foreground" />
          )}
        </div>

        <h1 className="text-lg font-semibold">{heading}</h1>
        {summary && (
          <p className="mt-1 font-mono-data text-2xl font-semibold">{formatGbp(summary.total_micros)}</p>
        )}
        <p className="mt-3 text-sm text-muted-foreground">{body}</p>

        <div className="mt-6 flex justify-center gap-2">
          <Link href="/compute">
            <Button>Go to Compute</Button>
          </Link>
          <Link href="/billing">
            <Button variant="outline">Billing</Button>
          </Link>
        </div>

        {failed && (
          <Link
            href="/compute"
            className="mt-4 inline-block text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          >
            Back to where you started
          </Link>
        )}
      </div>
    </main>
  );
}
