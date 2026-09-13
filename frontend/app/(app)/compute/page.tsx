import { backendJson } from "@/lib/backend-client";
import { getGpuTypes, getWallet, getRentals } from "@/lib/compute-client";
import { getSshKeys } from "@/lib/ssh-keys-client";
import { referenceCatalogAsGpuTiers } from "@/lib/gpu-catalog-reference";
import { WalletWidget } from "@/components/dashboard/wallet-widget";
import { RentPanel } from "./rent-panel";
import { RentalsList } from "./rentals-list";
import { SshKeysSection } from "./ssh-keys-section";
import { UnavailableNotice } from "@/components/ui/unavailable-notice";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
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
  // Fall back to the known reference catalog (real published rates) rather than
  // leaving the rent panel unusable if the live catalog endpoint has a blip —
  // pricing shown is then a fixed list price, not live-adjustable, until the
  // real endpoint recovers.
  const usingFallbackCatalog = !gpuTypesResult.ok;
  const gpuTypes = gpuTypesResult.ok ? gpuTypesResult.data : referenceCatalogAsGpuTiers();
  const wallet = walletResult.data;
  const rentals = rentalsResult.data;
  const sshKeys = sshKeysResult.data;

  const activeRentalKeyIds = rentals
    .filter((r) => r.status === "RUNNING" || r.status === "PROVISIONING" || r.status === "STOPPED")
    .map((r) => r.ssh_key_id);

  const concurrentUsed = rentals.filter((r) => r.status === "PROVISIONING" || r.status === "RUNNING" || r.status === "STOPPED").length;
  const anyUnavailable = !walletResult.ok || !rentalsResult.ok || !sshKeysResult.ok;

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">Compute</h1>
      <p className="mt-1.5 max-w-xl text-sm text-muted-foreground">Rent a dedicated GPU by the hour, or book one for a fixed period.</p>

      {anyUnavailable && (
        <div className="mt-4">
          <UnavailableNotice label="Some compute data" />
        </div>
      )}
      {usingFallbackCatalog && (
        <p className="mt-3 text-xs text-muted-foreground">
          Showing standard list pricing — live catalog data isn't reachable right now, so plan-specific promotions
          (if any) won't be reflected until it recovers.
        </p>
      )}

      <Tabs defaultValue="rent" className="mt-6">
        <TabsList>
          <TabsTrigger value="rent">Rent</TabsTrigger>
          <TabsTrigger value="ssh-keys">SSH keys {sshKeys.length > 0 && `(${sshKeys.length})`}</TabsTrigger>
        </TabsList>

        <TabsContent value="rent" className="mt-6 space-y-6">
          <WalletWidget balanceMicros={wallet.balance_micros} estimatedHoursRemaining={wallet.estimated_hours_remaining_at_current_rate} />
          <RentPanel gpuTypes={gpuTypes} sshKeys={sshKeys} plan={plan} walletBalanceMicros={wallet.balance_micros} concurrentUsed={concurrentUsed} />

          <div>
            <h2 className="mb-3 text-sm font-medium text-muted-foreground">Your rentals</h2>
            <RentalsList rentals={rentals} gpuTypes={gpuTypes} />
          </div>
        </TabsContent>

        <TabsContent value="ssh-keys" className="mt-6">
          <SshKeysSection keys={sshKeys} activeRentalKeyIds={activeRentalKeyIds} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
