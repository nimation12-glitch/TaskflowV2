/** Small typed fetch wrapper for the TaskFlow dashboard SPA. */

/**
 * Base URL of the TaskFlow API (the backend deployment), e.g.
 * https://api.web-agent.org. Empty string in same-origin deployments where
 * the Next.js app serves both the UI and /api/*.
 * Configured via NEXT_PUBLIC_API_BASE_URL (baked in at build time).
 */
export const API_BASE_URL = (process.env.NEXT_PUBLIC_API_BASE_URL ?? "").replace(/\/+$/, "");

/** Resolve an API path against the backend origin. */
export function apiUrl(path: string): string {
  return `${API_BASE_URL}${path}`;
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(apiUrl(path), {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    // "include" (not "same-origin"): the split frontend calls the backend
    // cross-origin, so the tf_session cookie must travel on every request.
    credentials: "include",
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
 * fetch the CSRF token from the backend, POST to its signin action, then
 * navigate to the returned authorization URL. The callbackUrl posted here is
 * SAME-ORIGIN with the API (so Auth.js core accepts it); the backend's
 * redirect policy rewrites it onto this frontend's /#/auth/finishing screen.
 * `link` mode is for the Account page's "Connect provider" buttons.
 */
export async function startOAuth(provider: string, mode: "signin" | "link" = "signin"): Promise<string> {
  const { csrfToken } = await api<{ csrfToken: string }>("/api/auth/csrf");
  const finishParams = new URLSearchParams({ provider });
  if (mode === "link") finishParams.set("mode", "link");
  const callbackUrl = apiUrl(`/oauth/finish?${finishParams.toString()}`);
  const res = await fetch(apiUrl(`/api/auth/signin/${provider}`), {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "X-Auth-Return-Redirect": "1",
    },
    body: new URLSearchParams({ csrfToken, callbackUrl }),
    credentials: "include",
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
