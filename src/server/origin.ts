/**
 * Trusted-origin validation — THE single source of truth for the
 * same-origin CSRF decision (correction spec §7, §14).
 *
 * This module is deliberately dependency-free (serverEnv only) so it can
 * run in the Edge runtime (src/proxy.ts) AND in the Node.js runtime
 * (tenancy/authz.ts defence-in-depth layer).
 *
 * A mutating request's Origin is accepted when ANY of:
 *   - the request's own Host (same-origin through any fronting proxy), or
 *   - APP_BASE_URL  (the canonical origin of this deployment), or
 *   - an explicit TRUSTED_ORIGINS entry (multi-environment deployments:
 *     http://localhost:3000 + the sandbox preview front in development,
 *     https://taskflow.web-agent.org in production).
 * Arbitrary hosts are NEVER trusted. An absent Origin is allowed (same-
 * origin navigations and server-to-server calls such as Stripe webhooks);
 * cross-site browser requests always carry an Origin header.
 */
import type { NextRequest } from "next/server";
import { serverEnv } from "@/server/env";

export function isAllowedOrigin(origin: string | null, req: Pick<NextRequest, "headers">): boolean {
  if (!origin) return true;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }
  const host = req.headers.get("host");
  if (host && originHost === host) return true;
  for (const base of serverEnv.trustedOrigins) {
    try {
      if (originHost === new URL(base).host) return true;
    } catch {
      // malformed entry — ignore it, never crash the gate
    }
  }
  return false;
}

/** HTTP methods that can change state and therefore require the origin check. */
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function isMutatingMethod(method: string): boolean {
  return MUTATING_METHODS.has(method.toUpperCase());
}
