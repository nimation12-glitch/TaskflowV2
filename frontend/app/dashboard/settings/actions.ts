"use server";

import { revalidatePath } from "next/cache";
import { addSshKey, deleteSshKey } from "@/lib/ssh-keys-client";

const KEY_PATTERN = /^(ssh-rsa|ssh-ed25519|ecdsa-sha2-\w+)\s+[A-Za-z0-9+/]+=*(\s+.*)?$/;
const PRIVATE_KEY_PATTERN = /BEGIN\s+(RSA|OPENSSH|EC|DSA)?\s*PRIVATE KEY/i;

export function validatePublicKey(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return "Paste your public key to continue.";
  if (PRIVATE_KEY_PATTERN.test(trimmed)) {
    return "This looks like a private key — paste your public key instead (usually ending in .pub).";
  }
  if (!KEY_PATTERN.test(trimmed)) {
    return "This doesn't look like a valid public key. It should start with ssh-rsa, ssh-ed25519, or ecdsa-sha2-*.";
  }
  return null;
}

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
