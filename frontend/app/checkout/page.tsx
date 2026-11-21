import Link from "next/link";
import { redirect } from "next/navigation";
import { Lock } from "lucide-react";
import { auth } from "@/auth";
import { backendJson, NoActiveOrganizationError, UnauthenticatedError } from "@/lib/backend-client";
import type { CheckoutSessionSummary } from "@/lib/checkout-types";
import { formatGbp } from "@/lib/utils";
import { LogoWordmark } from "@/components/logo-mark";
import { Button } from "@/components/ui/button";
import { CheckoutForm } from "./checkout-form";

export const metadata = { title: "Checkout — TaskFlow" };

/**
 * The one place a payment happens. The backend hands back a session id
 * instead of Stripe's hosted URL, so the customer stays on Taskflow: our
 * logo and order summary on the left, Stripe's secure card form on the right.
 */
export default async function CheckoutPage({ searchParams }: { searchParams: { cs?: string } }) {
  const cs = searchParams.cs?.trim() ?? "";
  const session = await auth();
  if (!session?.user?.id) {
    redirect(`/login?callbackUrl=${encodeURIComponent(cs ? `/checkout?cs=${cs}` : "/checkout")}`);
  }

  let summary: CheckoutSessionSummary | null = null;
  let failure: string | null = null;

  if (!cs) {
    failure = "This checkout link has no payment attached to it.";
  } else {
    try {
      summary = await backendJson<CheckoutSessionSummary>(
        `/billing/checkout/session?session_id=${encodeURIComponent(cs)}`
      );
      if (!summary.client_secret) {
        failure = "This payment session has expired. Start the checkout again.";
        summary = null;
      }
    } catch (err) {
      failure =
        err instanceof UnauthenticatedError || err instanceof NoActiveOrganizationError
          ? "Sign in with the account you're paying from to continue."
          : "We couldn't load this payment. Go back and try again.";
    }
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-background px-4 py-10">
      <div className="w-full max-w-4xl">
        <div className="mb-6 flex items-center justify-between">
          <LogoWordmark size={26} />
          <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <Lock className="h-3.5 w-3.5" />
            Secure checkout
          </span>
        </div>

        <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
          <section className="h-fit rounded-xl border border-border bg-card p-6">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Order summary</p>
            <h1 className="mt-2 text-lg font-semibold">{summary?.title ?? "TaskFlow purchase"}</h1>

            <dl className="mt-5 space-y-2.5 border-t border-border pt-4 text-sm">
              {(summary?.items ?? []).map((item) => (
                <div key={item.name} className="flex items-start justify-between gap-4">
                  <dt className="text-muted-foreground">{item.name}</dt>
                  <dd className="shrink-0 font-mono-data">{formatGbp(item.amount_micros)}</dd>
                </div>
              ))}
              {summary && summary.items.length === 0 && (
                <div className="flex items-center justify-between gap-4">
                  <dt className="text-muted-foreground">{summary.title}</dt>
                  <dd className="shrink-0 font-mono-data">{formatGbp(summary.total_micros)}</dd>
                </div>
              )}
            </dl>

            <div className="mt-4 flex items-center justify-between border-t border-border pt-4">
              <span className="text-sm font-medium">Total</span>
              <span className="font-mono-data text-xl font-semibold">
                {formatGbp(summary?.total_micros ?? 0)}
                {summary?.mode === "subscription" ? "/month" : ""}
              </span>
            </div>

            {summary?.mode === "subscription" && (
              <p className="mt-3 text-xs text-muted-foreground">
                Billed monthly. Manage or cancel any time from the Billing page.
              </p>
            )}

            <p className="mt-5 flex items-start gap-2 rounded-md bg-muted/40 p-3 text-xs text-muted-foreground">
              <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              Card details are entered on Stripe&apos;s encrypted form and never reach TaskFlow&apos;s servers.
            </p>

            <Link
              href="/compute"
              className="mt-4 inline-block text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
            >
              Cancel and go back
            </Link>
          </section>

          <section className="min-h-[26rem] rounded-xl border border-border bg-card p-6">
            {failure ? (
              <div className="flex h-full flex-col items-start justify-center gap-4">
                <h2 className="text-base font-semibold">Payment couldn&apos;t start</h2>
                <p className="text-sm text-muted-foreground">{failure}</p>
                <div className="flex gap-2">
                  <Link href="/compute">
                    <Button variant="outline" size="sm">Back to Compute</Button>
                  </Link>
                  <Link href="/billing">
                    <Button variant="outline" size="sm">Billing</Button>
                  </Link>
                </div>
              </div>
            ) : (
              summary && <CheckoutForm clientSecret={summary.client_secret!} sessionId={summary.session_id} />
            )}
          </section>
        </div>
      </div>
    </main>
  );
}
