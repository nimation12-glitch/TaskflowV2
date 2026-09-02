"use client";

/**
 * Billing — plan, credits, packages, invoices, upgrade/downgrade.
 * REAL Stripe Checkout only (spec §13): no simulated wording exists here.
 * Modes surfaced: Stripe live, Stripe Test Mode, unconfigured (fail closed).
 */

import { useCallback, useEffect, useState } from "react";
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { api, post, ApiError } from "@/lib/client-api";
import { formatGBP } from "@/lib/money";
import type { MeResponse, CheckoutContext, InvoiceRow, BillingMode } from "@/types/taskflow";
import { toast } from "@/hooks/use-toast";
import {
  Wallet, Receipt, ArrowUpCircle, ArrowDownCircle, Coins, ExternalLink, Loader2, Info, ShieldCheck,
} from "lucide-react";

function fmtDate(s: string | null): string {
  return s ? new Date(s).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "—";
}

/** Real billing states (spec §13) — synchronized from Stripe. */
function statusLabel(status: string): string {
  switch (status) {
    case "ACTIVE": return "Active";
    case "TRIALING": return "Trialing";
    case "PAST_DUE": return "Past due";
    case "PAYMENT_FAILED": return "Payment required";
    case "CANCELED": return "Canceled";
    case "INCOMPLETE": return "Payment required";
    default: return status;
  }
}

function statusBadgeClass(status: string): string {
  switch (status) {
    case "ACTIVE": return "border-emerald-300 bg-emerald-50 text-emerald-700";
    case "TRIALING": return "border-sky-300 bg-sky-50 text-sky-700";
    case "PAST_DUE": return "border-amber-300 bg-amber-50 text-amber-700";
    case "PAYMENT_FAILED":
    case "INCOMPLETE": return "border-rose-300 bg-rose-50 text-rose-700";
    case "CANCELED": return "border-slate-300 bg-slate-100 text-slate-600";
    default: return "border-slate-300 bg-slate-100 text-slate-600";
  }
}

function ModeBadge({ mode }: { mode: BillingMode | undefined }) {
  if (mode === "test") {
    return (
      <span className="ml-2 inline-flex items-center gap-1 rounded-md border border-amber-200 bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700">
        <ShieldCheck className="h-3 w-3" /> Stripe Test Mode — payments use Stripe test data
      </span>
    );
  }
  if (mode === "live") {
    return (
      <span className="ml-2 inline-flex items-center gap-1 rounded-md border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">
        <ShieldCheck className="h-3 w-3" /> Stripe — live payments
      </span>
    );
  }
  return (
    <span className="ml-2 inline-flex items-center gap-1 rounded-md border border-rose-200 bg-rose-50 px-2 py-0.5 text-xs font-medium text-rose-700">
      <Info className="h-3 w-3" /> Billing not configured on this deployment
    </span>
  );
}

type PendingAction =
  | { kind: "plan"; planId: string; planName: string; price: number }
  | { kind: "credits"; label: string; amountMicros: number }
  | null;

export function BillingView({ me, refreshMe }: { me: MeResponse; refreshMe: () => Promise<unknown> }) {
  const [ctx, setCtx] = useState<CheckoutContext | null>(null);
  const [invoices, setInvoices] = useState<InvoiceRow[] | null>(null);
  const [pending, setPending] = useState<PendingAction>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [c, i] = await Promise.all([
      api<CheckoutContext>("/api/billing/checkout").catch(() => null),
      api<{ invoices: InvoiceRow[] }>("/api/billing/invoices").catch(() => ({ invoices: [] })),
    ]);
    setCtx(c);
    setInvoices(i.invoices);
  }, []);

  useEffect(() => { load(); }, [load]);

  // ── Verification-on-return from Stripe Checkout (spec §6, §12) ──
  // The redirect back carries ?status=success&session_id=cs_…  The server
  // re-reads the session from Stripe and applies the same idempotent
  // fulfillment as webhooks; the URL is then cleaned up.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const status = params.get("status");
    const sessionId = params.get("session_id");
    if (!status) return;

    if (status === "cancelled") {
      toast({ title: "Checkout cancelled", description: "No payment was taken." });
    } else if (status === "success" && sessionId) {
      api<{ fulfilled: boolean; summary?: string; reason?: string }>(
        `/api/billing/checkout/verify?session_id=${encodeURIComponent(sessionId)}`,
      )
        .then((res) => {
          if (res.fulfilled) {
            toast({ title: "Payment confirmed", description: res.summary ?? "Your billing update has been applied." });
          } else {
            toast({
              title: "Payment not completed yet",
              description: res.reason ?? "Stripe has not confirmed this payment. It will appear automatically once confirmed.",
              variant: "destructive",
            });
          }
        })
        .catch((err) => {
          toast({
            title: "Verification failed",
            description: err instanceof ApiError ? err.message : "Could not verify the payment with Stripe.",
            variant: "destructive",
          });
        })
        .finally(() => {
          load();
          refreshMe();
        });
    }
    // Clean the URL so refreshes don't re-verify.
    window.history.replaceState({}, "", window.location.pathname + window.location.hash);
  }, []);

  async function confirmAction() {
    if (!pending) return;
    setBusy(true);
    try {
      if (pending.kind === "plan") {
        const res = await post<{ mode: string; checkoutUrl?: string; message?: string; downgraded?: boolean }>(
          "/api/billing/checkout",
          { kind: "subscription", planId: pending.planId },
        );
        if (res.checkoutUrl) {
          window.location.href = res.checkoutUrl; // Stripe-hosted checkout
          return;
        }
        toast({ title: res.message ?? "Plan updated" });
      } else {
        const res = await post<{ mode: string; checkoutUrl?: string }>(
          "/api/billing/checkout",
          { kind: "credits", amountMicros: pending.amountMicros },
        );
        if (res.checkoutUrl) {
          window.location.href = res.checkoutUrl;
          return;
        }
      }
      setPending(null);
      await Promise.all([load(), refreshMe()]);
    } catch (err) {
      toast({ title: err instanceof ApiError ? err.message : "Checkout failed", variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  const sub = me.subscription;
  const plans = ctx?.plans ?? [];
  const currentIdx = plans.findIndex((p) => p.id === sub?.planId);
  const configured = ctx?.mode === "live" || ctx?.mode === "test";
  const isFreePlan = sub?.planId === "free";

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-xl font-bold tracking-tight text-slate-900">Billing</h2>
        <p className="text-sm text-slate-500">
          Manage your plan, credits and invoices.
          <ModeBadge mode={ctx?.mode} />
        </p>
        {ctx && ctx.configIssues && ctx.configIssues.length > 0 && (
          <div className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            {ctx.configIssues.map((issue) => (
              <div key={issue}>• {issue}</div>
            ))}
          </div>
        )}
      </div>

      {/* Top row: plan + credits */}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader className="flex-row items-start justify-between pb-3">
            <div>
              <CardTitle className="text-base">Current plan</CardTitle>
              <CardDescription>Subscription status and period</CardDescription>
            </div>
            {sub && (
              <Badge variant="outline" className={statusBadgeClass(sub.status)}>
                {isFreePlan ? "Free plan" : statusLabel(sub.status)}
              </Badge>
            )}
          </CardHeader>
          <CardContent>
            {!sub ? (
              <p className="text-sm text-slate-500">No subscription found.</p>
            ) : (
              <div className="grid gap-4 sm:grid-cols-3">
                <div>
                  <div className="text-xs text-slate-500">Plan</div>
                  <div className="mt-1 text-lg font-bold text-slate-900">{sub.planName}</div>
                  <div className="text-xs text-slate-400">{formatGBP(sub.monthlyPriceMicros)}/month</div>
                </div>
                <div>
                  <div className="text-xs text-slate-500">Included credits</div>
                  <div className="mt-1 text-lg font-bold text-slate-900">{formatGBP(sub.monthlyCreditMicros)}</div>
                  <div className="text-xs text-slate-400">monthly allowance</div>
                </div>
                <div>
                  <div className="text-xs text-slate-500">Current period</div>
                  <div className="mt-1 text-sm font-semibold text-slate-900">
                    {fmtDate(sub.currentPeriodStart)} → {fmtDate(sub.currentPeriodEnd)}
                  </div>
                  <div className="text-xs text-slate-400">
                    {sub.cancelAtPeriodEnd ? "cancels at period end" : "renews automatically"}
                  </div>
                </div>
              </div>
            )}
            {(sub?.status === "PAST_DUE" || sub?.status === "PAYMENT_FAILED" || sub?.status === "INCOMPLETE") && (
              <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                A recent payment failed. No new monthly credits will be granted until Stripe confirms payment; if the
                issue persists, paid access will be restricted at the end of the grace period.
              </div>
            )}
            <Separator className="my-4" />
            <div className="flex flex-wrap gap-2">
              {sub?.cancelAtPeriodEnd && !isFreePlan ? (
                <Button
                  size="sm" variant="outline"
                  onClick={() => post("/api/billing/subscription", { action: "resume" }).then(() => refreshMe())}
                >
                  Resume subscription
                </Button>
              ) : sub && !isFreePlan ? (
                <Button size="sm" variant="outline" className="text-rose-600 hover:bg-rose-50" onClick={() => setPending({ kind: "plan", planId: "free", planName: "Free", price: 0 })}>
                  <ArrowDownCircle className="mr-1.5 h-4 w-4" /> Switch to Free at period end
                </Button>
              ) : null}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base"><Wallet className="h-4.5 w-4.5 text-emerald-600" /> Credit balance</CardTitle>
            <CardDescription>1 credit ≈ £1 of AI usage</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold tracking-tight text-slate-900">{formatGBP(me.credits.balanceMicros)}</div>
            <div className="mt-1 text-xs text-slate-400">Purchases add to this balance; usage debits it.</div>
            <div className="mt-4 grid grid-cols-2 gap-2">
              {(ctx?.creditPackages ?? []).map((p) => {
                const priceMissing = p.priceConfigured === false;
                return (
                  <Button
                    key={p.label}
                    variant="outline"
                    size="sm"
                    title={priceMissing ? "Stripe price not configured on this deployment" : undefined}
                    disabled={!configured || !!pending || priceMissing || (sub ? !sub.canBuyCredits : false)}
                    onClick={() => setPending({ kind: "credits", label: p.label, amountMicros: p.amountMicros })}
                  >
                    <Coins className="mr-1.5 h-3.5 w-3.5 text-emerald-600" /> {p.label}
                  </Button>
                );
              })}
            </div>
            {sub && !sub.canBuyCredits && (
              <p className="mt-3 text-xs text-amber-600">Credit purchases unlock on the Pro plan.</p>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Plans */}
      <div>
        <h3 className="mb-3 text-sm font-semibold text-slate-900">Plans</h3>
        <div className="grid gap-4 md:grid-cols-3">
          {plans.length === 0
            ? [0, 1, 2].map((i) => <Skeleton key={i} className="h-48 w-full" />)
            : plans.map((p) => {
                const isCurrent = p.id === sub?.planId;
                const isUpgrade = currentIdx >= 0 && plans.indexOf(p) > currentIdx;
                const priceMissing =
                  ctx?.pricesConfigured && (p.id === "pro" || p.id === "max")
                    ? !ctx.pricesConfigured[p.id as "pro" | "max"]
                    : false;
                return (
                  <Card key={p.id} className={isCurrent ? "border-emerald-400 ring-1 ring-emerald-200" : ""}>
                    <CardHeader className="pb-2">
                      <div className="flex items-center justify-between">
                        <CardTitle className="text-base">{p.name}</CardTitle>
                        {isCurrent && <Badge className="bg-emerald-600 text-white">Current</Badge>}
                      </div>
                      <div className="mt-1 flex items-baseline gap-1">
                        <span className="text-3xl font-bold text-slate-900">£{p.monthlyPriceGBP}</span>
                        <span className="text-sm text-slate-400">/month</span>
                      </div>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      <p className="text-xs leading-relaxed text-slate-500">{p.description}</p>
                      <div className="space-y-1 text-xs text-slate-600">
                        <div>Includes <span className="font-semibold">{formatGBP(p.monthlyCreditMicros)}</span> monthly credits</div>
                        <div>{p.rateLimitPerMinute} requests/minute · priority {p.priority} · {p.maxConcurrency} concurrent</div>
                        {p.canRentGpu && <div>Dedicated GPU rental (coming soon)</div>}
                      </div>
                      <Button
                        className={`w-full ${!isCurrent ? "bg-emerald-600 text-white hover:bg-emerald-500" : ""}`}
                        size="sm"
                        variant={isCurrent ? "outline" : "default"}
                        disabled={isCurrent || !!pending || (!configured && !isCurrent) || (priceMissing && !isCurrent)}
                        title={priceMissing && !isCurrent ? "Stripe price not configured on this deployment" : undefined}
                        onClick={() => setPending({ kind: "plan", planId: p.id, planName: p.name, price: p.monthlyPriceGBP })}
                      >
                        {isCurrent ? "Your plan" : isUpgrade ? (<><ArrowUpCircle className="mr-1.5 h-4 w-4" /> Switch to {p.name}</>) : `Switch to ${p.name}`}
                      </Button>
                    </CardContent>
                  </Card>
                );
              })}
        </div>
      </div>

      {/* Invoices */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base"><Receipt className="h-4.5 w-4.5 text-slate-500" /> Billing history</CardTitle>
          <CardDescription>Invoices for subscriptions and credit purchases</CardDescription>
        </CardHeader>
        <CardContent>
          {invoices === null ? (
            <Skeleton className="h-24 w-full" />
          ) : invoices.length === 0 ? (
            <p className="py-6 text-center text-sm text-slate-400">No invoices yet</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-140 text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-400">
                    <th className="pb-2 pr-4 font-medium">Invoice</th>
                    <th className="pb-2 pr-4 font-medium">Date</th>
                    <th className="pb-2 pr-4 font-medium">Description</th>
                    <th className="pb-2 pr-4 font-medium">Status</th>
                    <th className="pb-2 text-right font-medium">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {invoices.map((i) => (
                    <tr key={i.id} className="border-b border-slate-100 last:border-0">
                      <td className="py-2.5 pr-4 font-medium text-slate-900">
                        {i.number}
                        {i.hostedUrl && (
                          <a href={i.hostedUrl} target="_blank" rel="noreferrer" className="ml-1.5 inline-flex text-emerald-600" aria-label="View invoice">
                            <ExternalLink className="h-3 w-3" />
                          </a>
                        )}
                      </td>
                      <td className="py-2.5 pr-4 text-slate-500">{fmtDate(i.createdAt)}</td>
                      <td className="py-2.5 pr-4 text-slate-600">{i.description}</td>
                      <td className="py-2.5 pr-4">
                        <Badge variant="outline" className={i.status === "PAID" ? "border-emerald-300 bg-emerald-50 text-emerald-700" : "border-amber-300 bg-amber-50 text-amber-700"}>
                          {i.status}
                        </Badge>
                      </td>
                      <td className="py-2.5 text-right font-medium text-slate-900">{formatGBP(i.amountMicros)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Confirm dialog */}
      <Dialog open={!!pending} onOpenChange={(open) => { if (!open) setPending(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {pending?.kind === "plan" ? `Switch to the ${pending.planName} plan?` : `Buy ${pending?.label} of credits?`}
            </DialogTitle>
            <DialogDescription>
              You&apos;ll be redirected to Stripe&apos;s secure checkout to complete payment
              {ctx?.mode === "test" ? " using Stripe test data (Test Mode)." : "."}
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm">
            {pending?.kind === "plan" ? (
              <>
                <div className="flex justify-between"><span className="text-slate-500">Plan</span><span className="font-medium">{pending.planName}</span></div>
                <div className="mt-1 flex justify-between"><span className="text-slate-500">Price</span><span className="font-medium">£{pending.price}/month</span></div>
                <div className="mt-1 flex justify-between">
                  <span className="text-slate-500">Monthly credits</span>
                  <span className="font-medium">
                    {formatGBP(plans.find((p) => p.id === pending.planId)?.monthlyCreditMicros ?? 0)}
                  </span>
                </div>
              </>
            ) : (
              <div className="flex justify-between"><span className="text-slate-500">Credits</span><span className="font-medium">{pending?.label}</span></div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPending(null)} disabled={busy}>Cancel</Button>
            <Button className="bg-emerald-600 text-white hover:bg-emerald-500" onClick={confirmAction} disabled={busy}>
              {busy && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
              Continue to Stripe
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
