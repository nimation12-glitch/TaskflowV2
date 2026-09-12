/**
 * Routes that stay reachable even while maintenance mode blocks the rest of
 * the app. Kept to the bare minimum needed so an admin can always sign in
 * and turn maintenance mode back off — without this, flipping the toggle on
 * could lock every admin out of their own site (nobody has an active
 * session at the exact moment they need to disable it, e.g. after a cookie
 * expiry or on a new device).
 *
 * Deliberately NOT exempt: /signup (no reason to let new orgs form while the
 * product is down), /docs, /invite/[token], and everything in /dashboard —
 * the spec asks to block navigation to "the rest of the app", and none of
 * those are needed for account recovery.
 */
const EXEMPT_PREFIXES = ["/login", "/forgot-password", "/reset-password", "/api/auth", "/api/password-reset"];

export function isMaintenanceExempt(pathname: string): boolean {
  return EXEMPT_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}
