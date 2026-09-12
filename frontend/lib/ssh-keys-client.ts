import "server-only";
import { backendJson } from "@/lib/backend-client";
import type { SshKey } from "@/lib/compute-types";

export function getSshKeys() {
  return backendJson<SshKey[]>("/account/ssh-keys");
}

export function addSshKey(input: { label: string; public_key: string }) {
  return backendJson<SshKey>("/account/ssh-keys", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function deleteSshKey(id: string) {
  return backendJson<void>(`/account/ssh-keys/${id}`, { method: "DELETE" });
}
