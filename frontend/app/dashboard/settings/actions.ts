"use server";

import { revalidatePath } from "next/cache";
import { addSshKey, deleteSshKey } from "@/lib/ssh-keys-client";
import { validatePublicKey } from "@/lib/ssh-key-validation";

export async function addSshKeyAction(label: string, publicKey: string) {
  const error = validatePublicKey(publicKey);
  if (error) throw new Error(error);
  const key = await addSshKey({ label: label.trim(), public_key: publicKey.trim() });
  revalidatePath("/dashboard/settings");
  return key;
}

export async function deleteSshKeyAction(id: string) {
  await deleteSshKey(id);
  revalidatePath("/dashboard/settings");
}
