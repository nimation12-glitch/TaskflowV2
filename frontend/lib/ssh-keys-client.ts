import "server-only";
import { backendJson } from "@/lib/backend-client";
import type { SshKey } from "@/lib/compute-types";

/** Result of POST /account/ssh-keys/generate — the only place key material appears. */
export type GeneratedSshKey = SshKey & {
  public_key: string;
  /** Shown once for download; never stored server-side, never retrievable again. */
  private_key: string;
};

export async function getSshKeys() {
  const res = await backendJson<{ ssh_keys: SshKey[] }>("/account/ssh-keys");
  return res.ssh_keys;
}

export function addSshKey(input: { label: string; public_key: string }) {
  return backendJson<SshKey>("/account/ssh-keys", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** Server-side ed25519 keypair generation — private key returned exactly once. */
export function generateSshKey(label: string) {
  return backendJson<GeneratedSshKey>("/account/ssh-keys/generate", {
    method: "POST",
    body: JSON.stringify({ label }),
  });
}

export function deleteSshKey(id: string) {
  return backendJson<void>(`/account/ssh-keys/${id}`, { method: "DELETE" });
}
