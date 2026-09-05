import Link from "next/link";
import { backendJson } from "@/lib/backend-client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

type OrgSummary = {
  name: string;
  role: string;
  plan: { code: string; display_name: string; monthly_credit_micros: number } | null;
  subscription: { status: string | null } | null;
  credit_balance_micros: number;
};

function formatGbp(micros: number): string {
  return `£${(micros / 1_000_000).toFixed(2)}`;
}

export default async function DashboardOverview() {
  const org = await backendJson<OrgSummary>("/organizations/me");

  return (
    <div>
      <h1 className="text-2xl font-semibold">{org.name}</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        {org.plan?.display_name ?? "Free"} plan · {org.role.toLowerCase()}
      </p>

      <div className="mt-8 grid gap-4 sm:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>Credit balance</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="font-mono-data text-3xl font-semibold">{formatGbp(org.credit_balance_micros)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Monthly allowance</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="font-mono-data text-3xl font-semibold">
              {formatGbp(org.plan?.monthly_credit_micros ?? 0)}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Subscription status</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-semibold">{org.subscription?.status ?? "FREE"}</p>
          </CardContent>
        </Card>
      </div>

      <div className="mt-8 flex flex-wrap gap-3">
        <Link href="/dashboard/api-keys">
          <Button variant="secondary">Create API key</Button>
        </Link>
        <Link href="/dashboard/billing">
          <Button variant="secondary">Buy credits</Button>
        </Link>
        <Link href="/dashboard/billing">
          <Button variant="secondary">Upgrade plan</Button>
        </Link>
        <Link href="/dashboard/usage">
          <Button variant="secondary">View usage</Button>
        </Link>
      </div>
    </div>
  );
}
