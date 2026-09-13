import Link from "next/link";
import { backendJson } from "@/lib/backend-client";
import { getRentals } from "@/lib/compute-client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { PLAN_LIMITS, type PlanCode } from "@/lib/compute-types";
import { PlanTiers, ManageBillingButton } from "./billing-client";
import { UnavailableNotice } from "@/components/ui/unavailable-notice";
import { safe } from "@/lib/safe-fetch";

type OrgSummary = {
  plan: { code: PlanCode; display_name: string } | null;
  subscription: { status: string | null; current_period_end: string | null; cancel_at_period_end: boolean } | null;
};

export default async function BillingPage() {
  const [orgResult, rentalsResult] = await Promise.all([
    safe(backendJson<OrgSummary>("/organizations/me"), { plan: null, subscription: null }),
    safe(getRentals(), []),
  ]);
  const org = orgResult.data;
  const currentPlan = org.plan?.code ?? "FREE";
  const limits = PLAN_LIMITS[currentPlan];
  const concurrentUsed = rentalsResult.data.filter((r) => r.status === "PROVISIONING" || r.status === "RUNNING" || r.status === "STOPPED").length;

  return (
    <div className="max-w-3xl">
      <h1 className="text-2xl font-semibold tracking-tight">Billing</h1>
      <p className="mt-1.5 text-sm text-muted-foreground">Manage your plan and payment history. GPU wallet top-ups live on the Compute page.</p>

      {!orgResult.ok && (
        <div className="mt-4">
          <UnavailableNotice label="Plan details" />
        </div>
      )}

      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="text-foreground">Current plan</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <p className="text-lg font-semibold">{org.plan?.display_name ?? "Free"}</p>
              {org.subscription?.status && (
                <Badge variant={org.subscription.status === "active" ? "success" : "warning"}>{org.subscription.status}</Badge>
              )}
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              {org.subscription?.cancel_at_period_end
                ? "Cancels at the end of the current period"
                : org.subscription?.current_period_end
                  ? `Renews ${new Date(org.subscription.current_period_end).toLocaleDateString("en-GB", { day: "numeric", month: "long" })}`
                  : "No active subscription"}
            </p>
            <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 font-mono-data text-xs text-muted-foreground">
              <span>
                {rentalsResult.ok ? `${concurrentUsed}/${limits.concurrentRentals} concurrent rentals used` : "Concurrent rentals: unavailable"}
              </span>
              <span>{limits.maxStorageGb}GB storage max</span>
              <span>{limits.queuePriority} queue priority</span>
            </div>
          </div>
          {currentPlan !== "FREE" && <ManageBillingButton />}
        </CardContent>
      </Card>

      <h2 className="mt-10 text-sm font-medium text-muted-foreground">Plan</h2>
      <p className="mt-1 text-xs text-muted-foreground">
        Changing plans opens secure Stripe checkout — nothing changes until payment is confirmed.
      </p>
      <div className="mt-3">
        <PlanTiers currentPlan={currentPlan} />
      </div>

      <p className="mt-6 text-xs text-muted-foreground">
        Need to rent a GPU right now?{" "}
        <Link href="/compute" className="text-primary hover:underline">
          Go to Compute
        </Link>
        .
      </p>
    </div>
  );
}
