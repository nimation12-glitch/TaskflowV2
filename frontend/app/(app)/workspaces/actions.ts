"use server";

import { revalidatePath } from "next/cache";
import {
  createWorkspace,
  deleteWorkspace,
  resizeWorkspace,
  buyPrepaid,
  attachWorkspaceSshKey,
} from "@/lib/workspaces-client";

export async function createWorkspaceAction(input: {
  name: string;
  storage_size_gb: number;
  billing_mode: "hourly" | "prepaid_30d";
  ssh_key_id?: string;
}) {
  await createWorkspace(input);
  revalidatePath("/workspaces");
}

export async function deleteWorkspaceAction(id: string) {
  await deleteWorkspace(id);
  revalidatePath("/workspaces");
}

export async function resizeWorkspaceAction(id: string, storageSizeGb: number) {
  await resizeWorkspace(id, storageSizeGb);
  revalidatePath("/workspaces");
}

export async function buyPrepaidAction(id: string) {
  await buyPrepaid(id);
  revalidatePath("/workspaces");
}

export async function attachWorkspaceSshKeyAction(id: string, sshKeyId: string) {
  await attachWorkspaceSshKey(id, sshKeyId);
  revalidatePath("/workspaces");
}
