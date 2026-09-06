import { backendJson } from "@/lib/backend-client";
import { getGpuTypes, getWallet, getRentals } from "@/lib/compute-client";
import { getSshKeys } from "@/lib/ssh-keys-client";
import { WalletWidget } from "@/components/dashboard/wallet-widget";
import { RentPanel } from "./rent-panel";
import { RentalsList } from "./rentals-list";
import type { PlanCode } from "@/lib/compute-types";

type OrgSummary = { plan: { code: PlanCode } | null };

export default async function ComputePage() {
  const [gpuTypes, wallet, rentals, sshKeys, org] = await Promise.all([
    getGpuTypes(),
    getWallet(),
    getRentals(),
    getSshKeys(),
    backendJson<OrgSummary>("/organizations/me"),
  ]);

  const plan: PlanCode = org.plan?.code ?? "FREE";

  const concurrentUsed = rentals.filter((r) => r.status === "PROVISIONING" || r.status === "RUNNING" || r.status === "STOPPED").length;

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">Compute</h1>
      <p className="mt-1.5 max-w-xl text-sm text-muted-foreground">Rent a dedicated GPU by the hour, or book one for a fixed period.</p>

      <div className="mt-6">
        <WalletWidget balanceMicros={wallet.balance_micros} estimatedHoursRemaining={wallet.estimated_hours_remaining_at_current_rate} />
      </div>

      <div className="mt-6">
        <RentPanel gpuTypes={gpuTypes} sshKeys={sshKeys} plan={plan} walletBalanceMicros={wallet.balance_micros} concurrentUsed={concurrentUsed} />
      </div>

      <h2 className="mt-10 mb-3 text-sm font-medium text-muted-foreground">Your rentals</h2>
      <RentalsList rentals={rentals} gpuTypes={gpuTypes} />
    </div>
  );
}
