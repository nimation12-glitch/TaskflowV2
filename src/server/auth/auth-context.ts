/**
 * Request-scoped authentication context (AsyncLocalStorage).
 *
 * Auth.js (@auth/core) is framework-agnostic: its adapter and callback hooks
 * receive no HTTP request object, yet the TaskFlow security architecture
 * needs IP/user-agent capture on session rows (§8) and the sign-in policy
 * needs to know whether the caller ALREADY holds a valid session (link vs
 * sign-in, §6). Every entry point that drives Auth.js wraps the call in
 * runWithAuthContext(); the adapter / callbacks / authorize() then read the
 * ambient context.
 *
 * This module holds NO secrets — only non-sensitive request metadata and
 * login results (user id + raw session token) that never leave the process.
 */
import { AsyncLocalStorage } from "async_hooks";

export type AuthContext = {
  /** Best-effort client IP (behind the Caddy gateway). */
  ipAddress?: string | null;
  /** Raw User-Agent header. */
  userAgent?: string | null;
  /** The session user resolved from the incoming cookie, when one exists. */
  sessionUserId?: string | null;
  /**
   * Result stashed by the Credentials authorize() hook: which TaskFlow user
   * authenticated and the freshly-minted DB session token. Read back by the
   * /api/auth/login route to build its JSON response. Never serialized.
   */
  credentialsResult?: { userId: string } | null;
};

const storage = new AsyncLocalStorage<AuthContext>();

/** Run `fn` with an ambient auth context (per request). */
export function runWithAuthContext<T>(ctx: AuthContext, fn: () => Promise<T>): Promise<T> {
  return storage.run(ctx, fn);
}

/** Ambient context, or an empty one when not inside a wrapped request. */
export function getAuthContext(): AuthContext {
  return storage.getStore() ?? {};
}

/** Merge-in updates to the ambient context (no-op outside a wrapped request). */
export function updateAuthContext(patch: Partial<AuthContext>): void {
  const store = storage.getStore();
  if (store) Object.assign(store, patch);
}
