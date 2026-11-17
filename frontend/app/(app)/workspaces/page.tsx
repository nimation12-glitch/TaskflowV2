import { getWorkspaces, getStorageCatalogue } from "@/lib/workspaces-client";
import { getSshKeys } from "@/lib/ssh-keys-client";
import { backendJson } from "@/lib/backend-client";
import { WorkspacesClient } from "./workspaces-client";
import { UnavailableNotice } from "@/components/ui/unavailable-notice";
import { safe } from "@/lib/safe-fetch";
import type { PlanCode } from "@/lib/compute-types";

type OrgSummary = { plan: { code: PlanCode } | null };

export default async function WorkspacesPage() {
  const orgResult = await safe(backendJson<OrgSummary>("/organizations/me"), { plan: null });
  const plan: PlanCode = orgResult.data.plan?.code ?? "FREE";
  const [wsResult, storageResult, sshResult] = await Promise.all([
    safe(getWorkspaces(), { workspaces: [], slots: { used: 0, included: 0 } }),
    safe(getStorageCatalogue(), { sizes: [] }),
    safe(getSshKeys(), []),
  ]);

  const anyUnavailable = !wsResult.ok || !storageResult.ok || !sshResult.ok;

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">Workspaces</h1>
      <p className="mt-1.5 max-w-xl text-sm text-muted-foreground">
        A workspace is the persistent environment around your GPU work: storage and an SSH identity that survive
        between rentals. Attach one when you launch a GPU, reuse it with the next one.
      </p>

      {anyUnavailable && (
        <div className="mt-4">
          <UnavailableNotice label="Some workspace data" />
        </div>
      )}

      <div className="mt-6">
        <WorkspacesClient
          workspaces={wsResult.data.workspaces}
          slots={wsResult.data.slots}
          storageSizes={storageResult.data.sizes}
          sshKeys={sshResult.data}
          plan={plan}
        />
      </div>
    </div>
  );
}
