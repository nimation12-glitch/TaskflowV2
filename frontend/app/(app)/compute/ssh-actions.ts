"use server";

import { revalidatePath } from "next/cache";
import { addSshKey, deleteSshKey, generateSshKey, type GeneratedSshKey } from "@/lib/ssh-keys-client";
import { validatePublicKey } from "@/lib/ssh-key-validation";

// SSH keys are born inside the workspace-creation wizard now (the standalone
// SSH keys tab is gone) — these actions back its key step and cleanup.

export async function addSshKeyAction(label: string, publicKey: string) {
  const error = validatePublicKey(publicKey);
  if (error) throw new Error(error);
  const key = await addSshKey({ label: label.trim(), public_key: publicKey.trim() });
  revalidatePath("/compute");
  return key;
}

/** Generates an ed25519 keypair server-side; the private key comes back once. */
export async function generateSshKeyAction(label: string): Promise<GeneratedSshKey> {
  const key = await generateSshKey(label.trim() || "Taskflow key");
  revalidatePath("/compute");
  return key;
}

export async function deleteSshKeyAction(id: string) {
  await deleteSshKey(id);
  revalidatePath("/compute");
}
