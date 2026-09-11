import Link from "next/link";
import { Cpu, KeyRound, CreditCard, ArrowUpRight, Sparkles } from "lucide-react";
import { backendJson } from "@/lib/backend-client";
import { getGpuTypes, getWallet, getRentals } from "@/lib/compute-client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { WalletWidget } from "@/components/dashboard/wallet-widget";
import { RentalsList } from "@/app/dashboard/compute/rentals-list";
import { UnavailableNotice } from "@/components/ui/unavailable-notice";
import { safe } from "@/lib/safe-fetch";
import { PLAN_LIMITS, type PlanCode } from "@/lib/compute-types";

type OrgSummary = {
  name: string;
  role: string;
  plan: { code: PlanCode; display_name: string } | null;
};

const PLAN_BADGE_VARIANT: Record<PlanCode, "default" | "accent" | "success"> = {
  FREE: "default",
  PRO: "success",
  MAX: "accent",
};

export default async function DashboardOverview() {
  // org is core session data — if this fails, the workspace genuinely can't render,
  // so it's allowed to throw up to dashboard/error.tsx as before.
  const org = await backendJson<OrgSummary>("/organizations/me");

  // Compute endpoints are newer and may not be live on the backend yet — degrade
  // this section instead of crashing the whole page if any of them fail.
  const [walletResult, rentalsResult, gpuTypesResult] = await Promise.all([
    safe(getWallet(), { balance_micros: 0, estimated_hours_remaining_at_current_rate: null }),
    safe(getRentals(), []),
    safe(getGpuTypes(), []),
  ]);

  const computeUnavailable = !walletResult.ok || !rentalsResult.ok || !gpuTypesResult.ok;
  const wallet = walletResult.data;
  const rentals = rentalsResult.data;
  const gpuTypes = gpuTypesResult.data;

  const planCode = org.plan?.code ?? "FREE";
  const limits = PLAN_LIMITS[planCode];
  const concurrentUsed = rentals.filter((r) => r.status === "PROVISIONING" || r.status === "RUNNING" || r.status === "STOPPED").length;
  const recentRentals = rentals.slice(0, 3);

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2.5">
            <h1 className="text-2xl font-semibold tracking-tight">{org.name}</h1>
            <Badge variant={PLAN_BADGE_VARIANT[planCode]}>{org.plan?.display_name ?? "Free"}</Badge>
          </div>
          <p className="mt-1.5 text-sm capitalize text-muted-foreground">{org.role.toLowerCase()} on this workspace</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link href="/dashboard/settings">
            <Button variant="secondary" size="sm">
              <KeyRound className="h-3.5 w-3.5" />
              Manage SSH keys
            </Button>
          </Link>
          <Link href="/dashboard/billing">
            <Button variant="secondary" size="sm">
              <CreditCard className="h-3.5 w-3.5" />
              Upgrade plan
            </Button>
          </Link>
          <Link href="/dashboard/compute">
            <Button size="sm">
              <Cpu className="h-3.5 w-3.5" />
              Rent a GPU
            </Button>
          </Link>
        </div>
      </div>

      {computeUnavailable && (
        <div className="mt-6">
          <UnavailableNotice label="GPU rental data" />
        </div>
      )}

      <div className="mt-8 grid gap-4 sm:grid-cols-3">
        <WalletWidget balanceMicros={wallet.balance_micros} estimatedHoursRemaining={wallet.estimated_hours_remaining_at_current_rate} />
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle>Active rentals</CardTitle>
            <Cpu className="h-4 w-4 text-accent" strokeWidth={1.75} />
          </CardHeader>
          <CardContent>
            <p className="font-mono-data text-3xl font-semibold">
              {concurrentUsed} <span className="text-lg text-muted-foreground">of {limits.concurrentRentals}</span>
            </p>
            <p className="mt-1 text-xs text-muted-foreground">Concurrent rentals used on your plan</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle>Current plan</CardTitle>
            <Sparkles className="h-4 w-4 text-success" strokeWidth={1.75} />
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold">{org.plan?.display_name ?? "Free"}</p>
            <Link href="/dashboard/billing" className="mt-1 inline-flex items-center gap-1 text-xs text-primary hover:underline">
              Manage plan <ArrowUpRight className="h-3 w-3" />
            </Link>
          </CardContent>
        </Card>
      </div>

      <div className="mt-8 flex items-center justify-between">
        <h2 className="text-sm font-medium text-muted-foreground">Recent rentals</h2>
        <Link href="/dashboard/compute" className="text-xs text-primary hover:underline">
          View all
        </Link>
      </div>
      <div className="mt-3">
        <RentalsList rentals={recentRentals} gpuTypes={gpuTypes} />
      </div>
    </div>
  );
}
