"use client";

import { Check, ExternalLink, Receipt } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DialogTrigger } from "@/components/ui/dialog";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useAction } from "@/lib/hooks/use-action";
import { PLAN_LIMITS, type PlanCode } from "@/lib/compute-types";
import { checkoutSubscriptionAction, openBillingPortalAction } from "./actions";

const TIERS: { code: PlanCode; name: string; price: string; tagline: string; accent?: "primary" | "accent" }[] = [
  { code: "FREE", name: "Free", price: "£0/mo", tagline: "Starter GPUs, pay as you go." },
  { code: "PRO", name: "Pro", price: "£35/mo", tagline: "Standard GPUs for regular projects.", accent: "primary" },
  { code: "ULTRA", name: "Ultra", price: "£65/mo", tagline: "Pro-tier GPUs and more workspaces." },
  { code: "MAX", name: "Max", price: "£100/mo", tagline: "Everything, including Ultra-tier GPUs.", accent: "accent" },
];

function tierFeatures(code: PlanCode): string[] {
  const l = PLAN_LIMITS[code];
  const bookingNote = l.bookingAllowed ? "Pay-as-you-go or upfront day/week booking" : "Pay-as-you-go only";
  return [
    `${l.concurrentRentals} concurrent rental${l.concurrentRentals > 1 ? "s" : ""}`,
    `${l.maxStorageGb >= 1024 ? "1TB" : `${l.maxStorageGb}GB`} storage max`,
    code === "FREE" ? "4-hour maximum session length" : `${l.maxBookingDays}-day maximum rental length`,
    "All GPU time billed from your wallet — no included compute credits",
    bookingNote,
    `${l.queuePriority} queue priority`,
  ];
}

export function PlanTiers({ currentPlan }: { currentPlan: PlanCode }) {
  const { pending, run } = useAction();
  const order: PlanCode[] = ["FREE", "PRO", "ULTRA", "MAX"];
  const currentIndex = order.indexOf(currentPlan);

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {TIERS.map((tier, i) => {
        const isCurrent = tier.code === currentPlan;
        const isUpgrade = i > currentIndex;

        return (
          <Card
            key={tier.code}
            className={
              tier.accent === "primary"
                ? "border-primary/50 ring-1 ring-primary/20"
                : tier.accent === "accent"
                  ? "border-accent/50 ring-1 ring-accent/20"
                  : undefined
            }
          >
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className="text-base font-semibold text-foreground">{tier.name}</CardTitle>
                {isCurrent && <Badge variant="success">Current</Badge>}
                {tier.accent === "primary" && !isCurrent && <Badge variant="default">Popular</Badge>}
                {tier.accent === "accent" && !isCurrent && <Badge variant="accent">Premium</Badge>}
              </div>
              <p className="mt-2 text-2xl font-semibold">{tier.price}</p>
              <p className="text-xs text-muted-foreground">{tier.tagline}</p>
            </CardHeader>
            <CardContent>
              <ul className="space-y-2 text-sm">
                {tierFeatures(tier.code).map((f) => (
                  <li key={f} className="flex items-start gap-2 text-muted-foreground">
                    <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" />
                    {f}
                  </li>
                ))}
              </ul>

              <div className="mt-5">
                {isCurrent ? (
                  <Button className="w-full" variant="secondary" disabled>
                    Current plan
                  </Button>
                ) : tier.code === "FREE" ? (
                  <Button
                    className="w-full"
                    variant="outline"
                    loading={pending}
                    onClick={() => run(() => openBillingPortalAction(), { error: "Couldn't open billing management" })}
                  >
                    Manage in billing portal
                  </Button>
                ) : (
                  <ConfirmDialog
                    trigger={
                      <DialogTrigger asChild>
                        <Button className="w-full" variant={isUpgrade ? "primary" : "outline"}>
                          {isUpgrade ? `Upgrade to ${tier.name}` : `Downgrade to ${tier.name}`}
                        </Button>
                      </DialogTrigger>
                    }
                    title={`${isUpgrade ? "Upgrade" : "Downgrade"} to ${tier.name}`}
                    description={
                      <>
                        You'll be redirected to secure Stripe checkout to confirm the change. Your plan updates as
                        soon as payment completes
                        {isUpgrade
                          ? `, including your higher concurrent-rental limit immediately. GPU time is billed from your wallet either way.`
                          : " — any rentals above the new concurrent limit will need to be stopped."}
                      </>
                    }
                    confirmLabel="Continue to checkout"
                    pending={pending}
                    onConfirm={() =>
                      run(() => checkoutSubscriptionAction(tier.code as "PRO" | "ULTRA" | "MAX"), { error: "Couldn't start checkout" })
                    }
                  />
                )}
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

export function ManageBillingButton() {
  const { pending, run } = useAction();
  return (
    <Button
      variant="secondary"
      size="sm"
      loading={pending}
      onClick={() => run(() => openBillingPortalAction(), { error: "Couldn't open billing management" })}
    >
      <Receipt className="h-3.5 w-3.5" />
      Invoices & billing
      <ExternalLink className="h-3 w-3" />
    </Button>
  );
}
