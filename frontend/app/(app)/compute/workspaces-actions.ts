"use server";

import { revalidatePath } from "next/cache";
import {
  createWorkspace,
  deleteWorkspace,
  resizeWorkspace,
  buyPrepaid,
  attachWorkspaceSshKey,
  startWorkspaceGpu,
  type WorkspaceGpuStart,
} from "@/lib/workspaces-client";

// Workspaces live on the merged /compute page now (Catalogue / Workspaces
// tabs); every action revalidates that page. A workspace may carry its GPU
// (booted in the same request, all-or-nothing) — booking mode answers with a
// Stripe checkout URL the caller must send the customer to.

export async function createWorkspaceAction(input: {
  name: string;
  storage_size_gb: number;
  billing_mode: "hourly" | "prepaid_30d";
  ssh_key_id?: string;
  image_slug?: string;
  gpu?: WorkspaceGpuStart;
}) {
  const result = await createWorkspace(input);
  revalidatePath("/compute");
  return { checkout_url: result.checkout_url };
}

export async function startWorkspaceGpuAction(id: string, gpu: WorkspaceGpuStart) {
  const result = await startWorkspaceGpu(id, gpu);
  revalidatePath("/compute");
  return { checkout_url: result.checkout_url };
}

export async function deleteWorkspaceAction(id: string) {
  await deleteWorkspace(id);
  revalidatePath("/compute");
}

export async function resizeWorkspaceAction(id: string, storageSizeGb: number) {
  await resizeWorkspace(id, storageSizeGb);
  revalidatePath("/compute");
}

export async function buyPrepaidAction(id: string) {
  await buyPrepaid(id);
  revalidatePath("/compute");
}

export async function attachWorkspaceSshKeyAction(id: string, sshKeyId: string) {
  await attachWorkspaceSshKey(id, sshKeyId);
  revalidatePath("/compute");
}
