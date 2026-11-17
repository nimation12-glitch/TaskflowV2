import "server-only";
import { backendJson } from "@/lib/backend-client";

// Workspaces (spec §4/§22): persistent environments around GPU rentals —
// named storage + SSH identity that outlive compute. All shapes mirror
// backend/app/api/workspaces.py.

export type WorkspaceStatus = "ACTIVE" | "DELETED";

export type Workspace = {
  id: string;
  name: string;
  storage_size_gb: number;
  storage_display_name: string;
  /** True when the size equals the plan entitlement — never billed. */
  is_included: boolean;
  billing_mode: "HOURLY" | "PREPAID_30D";
  hourly_rate_micros: number;
  prepaid_price_micros: number | null;
  prepaid_expires_at: string | null;
  ssh_key_id: string | null;
  ssh_key_label: string | null;
  status: WorkspaceStatus;
  created_at: string;
  deleted_at: string | null;
  total_charged_micros: number;
  payment_overdue: boolean;
  active_gpu_instance_id: string | null;
};

export type WorkspaceSlots = { used: number; included: number };

export type StorageCatalogueSize = {
  size_gb: number;
  display_name: string;
  hourly_price_micros: number;
  prepaid_price_micros: number | null;
  is_included: boolean;
};

export async function getWorkspaces() {
  const res = await backendJson<{ workspaces: Workspace[]; slots: WorkspaceSlots }>("/workspaces");
  return res;
}

export function getStorageCatalogue() {
  return backendJson<{ sizes: StorageCatalogueSize[] }>("/workspaces/catalogue/storage");
}

export function createWorkspace(input: {
  name: string;
  storage_size_gb: number;
  billing_mode: "hourly" | "prepaid_30d";
  ssh_key_id?: string;
}) {
  return backendJson<Workspace>("/workspaces", { method: "POST", body: JSON.stringify(input) });
}

export function resizeWorkspace(id: string, storageSizeGb: number) {
  return backendJson<Workspace>(`/workspaces/${id}/storage`, {
    method: "POST",
    body: JSON.stringify({ storage_size_gb: storageSizeGb }),
  });
}

export function buyPrepaid(id: string) {
  return backendJson<Workspace>(`/workspaces/${id}/prepaid`, { method: "POST" });
}

export function attachWorkspaceSshKey(id: string, sshKeyId: string) {
  return backendJson<Workspace>(`/workspaces/${id}/ssh-key`, {
    method: "POST",
    body: JSON.stringify({ ssh_key_id: sshKeyId }),
  });
}

export function deleteWorkspace(id: string) {
  return backendJson<void>(`/workspaces/${id}`, { method: "DELETE" });
}
