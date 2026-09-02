/** Small typed fetch wrapper for the TaskFlow dashboard SPA. */

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    credentials: "same-origin",
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    throw new ApiError(res.status, data?.error ?? `Request failed (${res.status})`);
  }
  return data as T;
}

export const post = <T>(path: string, body: unknown) =>
  api<T>(path, { method: "POST", body: JSON.stringify(body) });

export const patch = <T>(path: string, body: unknown) =>
  api<T>(path, { method: "PATCH", body: JSON.stringify(body) });

export const del = <T>(path: string) => api<T>(path, { method: "DELETE" });

/**
 * Begin an Auth.js OAuth flow (Google / Microsoft / GitHub) from the SPA —
 * the documented manual flow the next-auth client implements under the hood:
 * fetch the CSRF token, POST to the framework's signin action, then navigate
 * to the returned authorization URL. `link` mode is for the Account page's
 * "Connect provider" buttons (the session cookie makes Auth.js link the new
 * identity to the signed-in user; the sign-in policy in authjs/policy.ts
 * enforces verification + clash rules server-side).
 */
export async function startOAuth(provider: string, mode: "signin" | "link" = "signin"): Promise<string> {
  const { csrfToken } = await api<{ csrfToken: string }>("/api/auth/csrf");
  const finishParams = new URLSearchParams({ provider });
  if (mode === "link") finishParams.set("mode", "link");
  const callbackUrl = `${window.location.origin}/#/auth/finishing?${finishParams.toString()}`;
  const res = await fetch(`/api/auth/signin/${provider}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "X-Auth-Return-Redirect": "1",
    },
    body: new URLSearchParams({ csrfToken, callbackUrl }),
    credentials: "same-origin",
  });
  const text = await res.text();
  let data: { url?: string; error?: string } = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error("OAuth sign-in could not be started");
  }
  if (!res.ok || !data.url) {
    throw new Error(data.error === "provider_not_configured" ? "This provider is not configured on this deployment" : "OAuth sign-in could not be started");
  }
  return data.url;
}
