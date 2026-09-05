import "server-only";
import { auth } from "@/auth";
import { signBackendToken } from "@/lib/internal-jwt";

export class UnauthenticatedError extends Error {}
export class NoActiveOrganizationError extends Error {}

/**
 * Every server component/route handler that needs org-scoped data calls
 * this. It resolves the NextAuth session, mints a 60s backend token, and
 * proxies the request. The browser never talks to the FastAPI backend
 * directly for these routes.
 */
export async function backendFetch(path: string, init?: RequestInit): Promise<Response> {
  const session = await auth();
  if (!session?.user?.id) throw new UnauthenticatedError();
  if (!session.activeOrganizationId || !session.activeRole) throw new NoActiveOrganizationError();

  const token = await signBackendToken({
    userId: session.user.id,
    organizationId: session.activeOrganizationId,
    role: session.activeRole,
  });

  const base = process.env.BACKEND_URL;
  if (!base) throw new Error("BACKEND_URL is not set");

  return fetch(`${base.replace(/\/$/, "")}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(init?.headers ?? {}),
    },
    cache: "no-store",
  });
}

export async function backendJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await backendFetch(path, init);
  if (!res.ok) {
    throw new Error(`Backend request failed (${res.status}): ${await res.text()}`);
  }
  return res.json();
}
