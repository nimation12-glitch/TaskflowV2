import "server-only";
import { backendJson } from "@/lib/backend-client";

// ASSUMPTION FLAG: pause/resume aren't part of any confirmed backend contract
// I've been given — the rest of this file (list/create/revoke) mirrors the
// original AI-gateway API key endpoints. If the real backend's shape differs,
// this is the one file to reconcile.
export type ApiKeyStatus = "ACTIVE" | "PAUSED" | "REVOKED";

export type ApiKey = {
  id: string;
  name: string;
  prefix: string;
  status: ApiKeyStatus;
  created_at: string;
  last_used_at: string | null;
};

export type CreatedApiKey = ApiKey & { raw_key: string };

export function getApiKeys() {
  return backendJson<ApiKey[]>("/api-keys");
}

export function createApiKey(name: string) {
  return backendJson<CreatedApiKey>("/api-keys", { method: "POST", body: JSON.stringify({ name }) });
}

export function revokeApiKey(id: string) {
  return backendJson<ApiKey>(`/api-keys/${id}/revoke`, { method: "POST" });
}

/** Temporarily stops the key from authenticating without permanently revoking it. */
export function pauseApiKey(id: string) {
  return backendJson<ApiKey>(`/api-keys/${id}/pause`, { method: "POST" });
}

export function resumeApiKey(id: string) {
  return backendJson<ApiKey>(`/api-keys/${id}/resume`, { method: "POST" });
}
