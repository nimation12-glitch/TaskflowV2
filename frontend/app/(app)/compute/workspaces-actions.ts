"use server";

import { revalidatePath } from "next/cache";
import {
  createWorkspace,
  deleteWorkspace,
  resizeWorkspace,
  buyPrepaid,
  attachWorkspaceSshKey,
} from "@/lib/workspaces-client";

// Workspaces live on the merged /compute page now (Catalogue / Workspaces /
// SSH keys tabs); every action revalidates that page.

export async function createWorkspaceAction(input: {
  name: string;
  storage_size_gb: number;
  billing_mode: "hourly" | "prepaid_30d";
  ssh_key_id?: string;
}) {
  await createWorkspace(input);
  revalidatePath("/compute");
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
