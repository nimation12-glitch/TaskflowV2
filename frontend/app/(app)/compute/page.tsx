import { backendJson } from "@/lib/backend-client";
import { getGpuTypes, getWallet, getRentals, getMachineImages } from "@/lib/compute-client";
import { getWorkspaces, getStorageCatalogue } from "@/lib/workspaces-client";
import { getSshKeys } from "@/lib/ssh-keys-client";
import { WalletWidget } from "@/components/dashboard/wallet-widget";
import { CataloguePanel } from "./catalogue-panel";
import { RentalsList } from "./rentals-list";
import { WorkspacesSection, type ActiveRentalInfo } from "./workspaces-section";
import { UnavailableNotice } from "@/components/ui/unavailable-notice";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { safe } from "@/lib/safe-fetch";
import type { PlanCode } from "@/lib/compute-types";

type OrgSummary = { plan: { code: PlanCode } | null };

export default async function ComputePage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }> | { tab?: string };
}) {
  const { tab } = await searchParams;
  const defaultTab = tab === "workspaces" ? tab : "catalogue";
  const orgResult = await safe(backendJson<OrgSummary>("/organizations/me"), { plan: null });
  const [gpuTypesResult, walletResult, rentalsResult, sshKeysResult, workspacesResult, storageResult, imagesResult] =
    await Promise.all([
      safe(getGpuTypes(), []),
      safe(getWallet(), { balance_micros: 0, estimated_hours_remaining_at_current_rate: null }),
      safe(getRentals(), []),
      safe(getSshKeys(), []),
      safe(getWorkspaces(), { workspaces: [], slots: { used: 0, included: 0 } }),
      safe(getStorageCatalogue(), { sizes: [] }),
      safe(getMachineImages(), []),
    ]);

  const plan: PlanCode = orgResult.data.plan?.code ?? "FREE";
  const gpuTypes = gpuTypesResult.ok ? gpuTypesResult.data : [];
  const wallet = walletResult.data;
  const rentals = rentalsResult.data;
  const sshKeys = sshKeysResult.data;
  const { workspaces, slots } = workspacesResult.data;
  const storageSizes = storageResult.ok ? storageResult.data.sizes : [];
  const images = imagesResult.ok ? imagesResult.data : [];

  const anyUnavailable =
    !gpuTypesResult.ok ||
    !walletResult.ok ||
    !rentalsResult.ok ||
    !sshKeysResult.ok ||
    !workspacesResult.ok ||
    !imagesResult.ok;

  const concurrentUsed = rentals.filter((r) =>
    ["PENDING_PAYMENT", "PROVISIONING", "RUNNING", "STOPPED", "STOPPING"].includes(r.status)
  ).length;

  // Workspace names for rental cards + attach dropdown (id -> name).
  const workspaceSummaries = workspaces
    .filter((w) => w.status === "ACTIVE")
    .map((w) => ({ id: w.id, name: w.name, storage_size_gb: w.storage_size_gb, ssh_key_id: w.ssh_key_id, ssh_key_label: w.ssh_key_label }));

  // Connection facts per workspace (public IP / region) for the Connect panel.
  const activeRentalByWorkspace: Record<string, ActiveRentalInfo> = {};
  for (const r of rentals) {
    if (r.workspace_id && ["PROVISIONING", "RUNNING", "STOPPING"].includes(r.status)) {
      activeRentalByWorkspace[r.workspace_id] = {
        public_ip: r.public_ip,
        region_code: r.region_code,
        status: r.status,
      };
    }
  }

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">Compute</h1>
      <p className="mt-1.5 max-w-xl text-sm text-muted-foreground">
        Browse the GPU families and machine images below — then create a workspace, choose its GPU there, and Taskflow
        boots the machine on AWS and starts billing. Persistent storage and your SSH identity survive between rentals.
      </p>

      {anyUnavailable && (
        <div className="mt-4">
          <UnavailableNotice label="Some compute data" />
        </div>
      )}

      <Tabs defaultValue={defaultTab} className="mt-6">
        <TabsList>
          <TabsTrigger value="catalogue">Catalogue</TabsTrigger>
          <TabsTrigger value="workspaces">
            Workspaces {workspaces.length > 0 && `(${workspaces.length})`}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="catalogue" className="mt-6 space-y-6">
          <WalletWidget balanceMicros={wallet.balance_micros} estimatedHoursRemaining={wallet.estimated_hours_remaining_at_current_rate} />
          <CataloguePanel gpuTypes={gpuTypes} images={images} plan={plan} />
          <div>
            <h2 className="mb-3 text-sm font-medium text-muted-foreground">Your rentals</h2>
            <RentalsList
              rentals={rentals}
              gpuTypes={gpuTypes}
              workspaceNames={Object.fromEntries(workspaceSummaries.map((w) => [w.id, w.name]))}
            />
          </div>
        </TabsContent>

        <TabsContent value="workspaces" className="mt-6">
          <WorkspacesSection
            workspaces={workspaces}
            slots={slots}
            storageSizes={storageSizes}
            sshKeys={sshKeys}
            plan={plan}
            gpuTypes={gpuTypes}
            images={images}
            concurrentUsed={concurrentUsed}
            walletBalanceMicros={wallet.balance_micros}
            activeRentalByWorkspace={activeRentalByWorkspace}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
