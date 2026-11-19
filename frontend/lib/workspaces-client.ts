import "server-only";
import { backendJson } from "@/lib/backend-client";
import type { LocationPreference } from "@/lib/compute-types";

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
  /** Machine image this workspace boots; null = platform default. */
  image_id: string | null;
  image_slug: string | null;
  image_display_name: string | null;
  status: WorkspaceStatus;
  created_at: string;
  deleted_at: string | null;
  total_charged_micros: number;
  payment_overdue: boolean;
  active_gpu_instance_id: string | null;
  /** How many active GPUs are attached (multi-GPU orders share a workspace). */
  active_gpu_count: number;
};

/** The GPU half of a workspace: booted in the same request as the workspace. */
export type WorkspaceGpuStart = {
  gpu_type_slug: string;
  /** N identical GPUs as one order (1..10); plan concurrency re-checked server-side. */
  quantity?: number;
  payment_mode?: "pay_as_you_go" | "booking";
  booking_duration?: "day" | "week";
  location_preference?: LocationPreference;
};

/** POST /workspaces and POST /workspaces/{id}/gpu both answer with this. */
export type WorkspaceLaunchResult = Workspace & {
  /** Stripe checkout URL for booking mode; null when the GPU boots now. */
  checkout_url: string | null;
  /** True when a GPU was requested (and launched, or sent to checkout). */
  gpu_started: boolean;
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
  /** Machine image the workspace boots (image catalogue); omit for the default. */
  image_slug?: string;
  /**
   * Present = create the workspace AND boot its GPU in one all-or-nothing
   * request: any failure rolls the workspace back and no money has moved.
   */
  gpu?: WorkspaceGpuStart;
}) {
  return backendJson<WorkspaceLaunchResult>("/workspaces", { method: "POST", body: JSON.stringify(input) });
}

/** Start (or add) the GPU on an existing workspace. */
export function startWorkspaceGpu(id: string, gpu: WorkspaceGpuStart) {
  return backendJson<WorkspaceLaunchResult>(`/workspaces/${id}/gpu`, {
    method: "POST",
    body: JSON.stringify(gpu),
  });
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
