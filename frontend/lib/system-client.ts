import "server-only";
import { backendJson } from "@/lib/backend-client";

export type SystemStatus = {
  maintenance_mode_enabled: boolean;
  maintenance_message: string | null;
};

/**
 * Public, unauthenticated — callable by anonymous visitors. Deliberately
 * does NOT go through backendFetch/backendJson (which requires a signed-in
 * session with an active org) since this must work for people with no
 * session at all, on every page load including the landing page.
 */
export async function getSystemStatus(): Promise<SystemStatus> {
  const base = process.env.BACKEND_URL;
  if (!base) throw new Error("BACKEND_URL is not set");
  const res = await fetch(`${base.replace(/\/$/, "")}/system/status`, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`getSystemStatus failed (${res.status}): ${await res.text()}`);
  }
  return res.json();
}

export type MaintenanceUpdateResult = SystemStatus & {
  updated_by_user_id: string;
  updated_at: string;
};

/** Admin-only — the backend rejects this with 403 unless the JWT carries is_platform_admin: true. */
export function setMaintenanceMode(input: { enabled: boolean; message: string | null }) {
  return backendJson<MaintenanceUpdateResult>("/system/maintenance", {
    method: "POST",
    body: JSON.stringify(input),
  });
}
