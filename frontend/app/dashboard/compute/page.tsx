import { backendJson } from "@/lib/backend-client";
import { getGpuTypes, getWallet, getRentals } from "@/lib/compute-client";
import { getSshKeys } from "@/lib/ssh-keys-client";
import { WalletWidget } from "@/components/dashboard/wallet-widget";
import { RentPanel } from "./rent-panel";
import { RentalsList } from "./rentals-list";
import { UnavailableNotice } from "@/components/ui/unavailable-notice";
import { safe } from "@/lib/safe-fetch";
import type { PlanCode } from "@/lib/compute-types";

type OrgSummary = { plan: { code: PlanCode } | null };

export default async function ComputePage() {
  const orgResult = await safe(backendJson<OrgSummary>("/organizations/me"), { plan: null });
  const [gpuTypesResult, walletResult, rentalsResult, sshKeysResult] = await Promise.all([
    safe(getGpuTypes(), []),
    safe(getWallet(), { balance_micros: 0, estimated_hours_remaining_at_current_rate: null }),
    safe(getRentals(), []),
    safe(getSshKeys(), []),
  ]);

  const plan: PlanCode = orgResult.data.plan?.code ?? "FREE";
  const gpuTypes = gpuTypesResult.data;
  const wallet = walletResult.data;
  const rentals = rentalsResult.data;
  const sshKeys = sshKeysResult.data;

  const concurrentUsed = rentals.filter((r) => r.status === "PROVISIONING" || r.status === "RUNNING" || r.status === "STOPPED").length;
  const anyUnavailable = !gpuTypesResult.ok || !walletResult.ok || !rentalsResult.ok || !sshKeysResult.ok;

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">Compute</h1>
      <p className="mt-1.5 max-w-xl text-sm text-muted-foreground">Rent a dedicated GPU by the hour, or book one for a fixed period.</p>

      {anyUnavailable && (
        <div className="mt-4">
          <UnavailableNotice label="Some compute data" />
        </div>
      )}

      <div className="mt-6">
        <WalletWidget balanceMicros={wallet.balance_micros} estimatedHoursRemaining={wallet.estimated_hours_remaining_at_current_rate} />
      </div>

      <div className="mt-6">
        {gpuTypesResult.ok ? (
          <RentPanel gpuTypes={gpuTypes} sshKeys={sshKeys} plan={plan} walletBalanceMicros={wallet.balance_micros} concurrentUsed={concurrentUsed} />
        ) : (
          <div className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
            The GPU catalog isn't available right now — try refreshing in a moment.
          </div>
        )}
      </div>

      <h2 className="mt-10 mb-3 text-sm font-medium text-muted-foreground">Your rentals</h2>
      <RentalsList rentals={rentals} gpuTypes={gpuTypes} />
    </div>
  );
}