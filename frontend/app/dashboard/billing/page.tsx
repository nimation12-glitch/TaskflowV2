import { backendJson } from "@/lib/backend-client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { checkoutSubscriptionAction, checkoutCreditsAction, openBillingPortalAction } from "./actions";

type OrgSummary = {
  plan: { code: string; display_name: string; monthly_price_micros: number } | null;
  subscription: { status: string | null; current_period_end: string | null; cancel_at_period_end: boolean } | null;
  credit_balance_micros: number;
};

const CREDIT_PACKAGES = [
  { label: "£10", amountMicros: 10_000_000 },
  { label: "£25", amountMicros: 25_000_000 },
  { label: "£50", amountMicros: 50_000_000 },
  { label: "£100", amountMicros: 100_000_000 },
];

function formatGbp(micros: number): string {
  return `£${(micros / 1_000_000).toFixed(2)}`;
}

export default async function BillingPage() {
  const org = await backendJson<OrgSummary>("/organizations/me");
  const currentPlan = org.plan?.code ?? "FREE";

  return (
    <div className="max-w-3xl">
      <h1 className="text-2xl font-semibold">Billing</h1>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Current plan</CardTitle>
        </CardHeader>
        <CardContent className="flex items-center justify-between">
          <div>
            <p className="text-lg font-semibold">{org.plan?.display_name ?? "Free"}</p>
            <p className="text-sm text-muted-foreground">
              {org.subscription?.status ?? "No active subscription"}
              {org.subscription?.cancel_at_period_end && " · cancels at period end"}
            </p>
            <p className="mt-1 font-mono-data text-sm text-muted-foreground">
              Balance: {formatGbp(org.credit_balance_micros)}
            </p>
          </div>
          {currentPlan !== "FREE" && (
            <form action={openBillingPortalAction}>
              <Button type="submit" variant="secondary">
                Manage billing
              </Button>
            </form>
          )}
        </CardContent>
      </Card>

      <h2 className="mt-10 text-sm font-medium text-muted-foreground">Upgrade</h2>
      <div className="mt-3 grid gap-4 sm:grid-cols-2">
        {(["PRO", "MAX"] as const).map((plan) => (
          <Card key={plan}>
            <CardHeader>
              <CardTitle className="text-foreground">{plan === "PRO" ? "Pro — £30/mo" : "Max — £90/mo"}</CardTitle>
            </CardHeader>
            <CardContent>
              <form action={checkoutSubscriptionAction.bind(null, plan)}>
                <Button type="submit" className="w-full" disabled={currentPlan === plan}>
                  {currentPlan === plan ? "Current plan" : `Upgrade to ${plan === "PRO" ? "Pro" : "Max"}`}
                </Button>
              </form>
            </CardContent>
          </Card>
        ))}
      </div>

      <h2 className="mt-10 text-sm font-medium text-muted-foreground">Buy credits</h2>
      <div className="mt-3 grid grid-cols-4 gap-3">
        {CREDIT_PACKAGES.map((pkg) => (
          <form key={pkg.label} action={checkoutCreditsAction.bind(null, pkg.amountMicros)}>
            <Button type="submit" variant="secondary" className="w-full">
              {pkg.label}
            </Button>
          </form>
        ))}
      </div>
    </div>
  );
}
