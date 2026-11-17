import { backendJson } from "@/lib/backend-client";
import { getGpuTypes, getWallet, getRentals } from "@/lib/compute-client";
import { getWorkspaces } from "@/lib/workspaces-client";
import { getSshKeys } from "@/lib/ssh-keys-client";
import { WalletWidget } from "@/components/dashboard/wallet-widget";
import { CataloguePanel } from "./catalogue-panel";
import { RentalsList } from "./rentals-list";
import { SshKeysSection } from "./ssh-keys-section";
import { UnavailableNotice } from "@/components/ui/unavailable-notice";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { safe } from "@/lib/safe-fetch";
import type { PlanCode } from "@/lib/compute-types";

type OrgSummary = { plan: { code: PlanCode } | null };

export default async function ComputePage() {
  const orgResult = await safe(backendJson<OrgSummary>("/organizations/me"), { plan: null });
  const [gpuTypesResult, walletResult, rentalsResult, sshKeysResult, workspacesResult] = await Promise.all([
    safe(getGpuTypes(), []),
    safe(getWallet(), { balance_micros: 0, estimated_hours_remaining_at_current_rate: null }),
    safe(getRentals(), []),
    safe(getSshKeys(), []),
    safe(getWorkspaces(), { workspaces: [], slots: { used: 0, included: 0 } }),
  ]);

  const plan: PlanCode = orgResult.data.plan?.code ?? "FREE";
  const gpuTypes = gpuTypesResult.ok ? gpuTypesResult.data : [];
  const wallet = walletResult.data;
  const rentals = rentalsResult.data;
  const sshKeys = sshKeysResult.data;
  const { workspaces } = workspacesResult.data;

  const anyUnavailable = !gpuTypesResult.ok || !walletResult.ok || !rentalsResult.ok || !sshKeysResult.ok;

  const activeRentalKeyIds = rentals
    .filter((r) => ["PROVISIONING", "RUNNING", "STOPPED", "STOPPING", "PENDING_PAYMENT"].includes(r.status))
    .map((r) => r.ssh_key_id);

  const concurrentUsed = rentals.filter((r) =>
    ["PENDING_PAYMENT", "PROVISIONING", "RUNNING", "STOPPED", "STOPPING"].includes(r.status)
  ).length;

  // Workspace names for rental cards + attach dropdown (id -> name).
  const workspaceSummaries = workspaces
    .filter((w) => w.status === "ACTIVE")
    .map((w) => ({ id: w.id, name: w.name, storage_size_gb: w.storage_size_gb, ssh_key_id: w.ssh_key_id, ssh_key_label: w.ssh_key_label }));

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">Compute</h1>
      <p className="mt-1.5 max-w-xl text-sm text-muted-foreground">
        Dedicated GPUs, rented by the hour from your wallet or booked for a fixed period. You pick the GPU — we
        automatically pick the best region for it.
      </p>

      {anyUnavailable && (
        <div className="mt-4">
          <UnavailableNotice label="Some compute data" />
        </div>
      )}

      <Tabs defaultValue="catalogue" className="mt-6">
        <TabsList>
          <TabsTrigger value="catalogue">Catalogue</TabsTrigger>
          <TabsTrigger value="ssh-keys">SSH keys {sshKeys.length > 0 && `(${sshKeys.length})`}</TabsTrigger>
        </TabsList>

        <TabsContent value="catalogue" className="mt-6 space-y-6">
          <WalletWidget balanceMicros={wallet.balance_micros} estimatedHoursRemaining={wallet.estimated_hours_remaining_at_current_rate} />
          <CataloguePanel
            gpuTypes={gpuTypes}
            sshKeys={sshKeys}
            workspaces={workspaceSummaries}
            plan={plan}
            walletBalanceMicros={wallet.balance_micros}
            concurrentUsed={concurrentUsed}
          />
          <div>
            <h2 className="mb-3 text-sm font-medium text-muted-foreground">Your rentals</h2>
            <RentalsList
              rentals={rentals}
              gpuTypes={gpuTypes}
              workspaceNames={Object.fromEntries(workspaceSummaries.map((w) => [w.id, w.name]))}
            />
          </div>
        </TabsContent>

        <TabsContent value="ssh-keys" className="mt-6">
          <SshKeysSection keys={sshKeys} activeRentalKeyIds={activeRentalKeyIds} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
