/**
 * Centralized server-side authorization (Phase 1 §23–§25).
 *
 * THE security model:
 *   session → user → membership(active org) → role → capability
 *
 * Rules enforced here and ONLY here:
 *  - the active-org cookie is NEVER trusted alone: membership is re-validated
 *    against the database on every request (§23)
 *  - every organization-owned resource is queried with organizationId scoping
 *    — frontend filtering is not security (§24)
 *  - role hierarchy: OWNER > ADMIN > MEMBER; billing actions are OWNER-only
 *    (§25); no authorization logic in frontend components
 */
import { createHmac, timingSafeEqual } from "crypto";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { serverEnv } from "@/server/env";
import { isAllowedOrigin } from "@/server/origin";
import { resolveSession, SESSION_COOKIE } from "@/server/auth/session";
import type { Membership, Organization, User } from "@prisma/client";

export type OrgRole = "OWNER" | "ADMIN" | "MEMBER";

const ROLE_RANK: Record<OrgRole, number> = { MEMBER: 1, ADMIN: 2, OWNER: 3 };

export function isOrgRole(value: string): value is OrgRole {
  return value === "OWNER" || value === "ADMIN" || value === "MEMBER";
}

/** Does `role` meet the minimum required role? */
export function roleAtLeast(role: string, min: OrgRole): boolean {
  return isOrgRole(role) && ROLE_RANK[role] >= ROLE_RANK[min];
}

/** True when the user is the LAST OWNER (used to prevent lock-out mutations). */
export async function isLastOwner(organizationId: string, userId: string): Promise<boolean> {
  const owners = await db.membership.count({ where: { organizationId, role: "OWNER" } });
  if (owners !== 1) return false;
  const own = await db.membership.findUnique({
    where: { organizationId_userId: { organizationId, userId } },
  });
  return own?.role === "OWNER";
}

export const ORG_COOKIE = "tf_org";

export type MembershipWithOrg = Membership & { organization: Organization };

/**
 * Authenticated request context: the session user plus their ACTIVE
 * organization (validated membership), all memberships, and the role in the
 * active org. Returned by every dashboard API's authorization step.
 */
export type OrgContext = {
  user: User;
  organization: Organization;
  membership: Membership;
  memberships: Array<{ organization: Organization; membership: Membership }>;
  role: OrgRole;
};

export class OrgContextError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "OrgContextError";
  }
}

/**
 * Build the org context for a request:
 *  1. resolve + validate the session (expired/revoked/suspended ⇒ 401)
 *  2. pick the active organization: `tf_org` cookie if it carries a valid
 *     membership, otherwise the first membership (personal org first)
 *  3. load memberships for the switcher (never exposes orgs the user is not
 *     a member of — §42)
 */
export async function getOrgContext(req: NextRequest): Promise<OrgContext> {
  const resolved = await resolveSession(req);
  if (!resolved) {
    throw new OrgContextError(401, "not_authenticated", "Not authenticated");
  }
  // Pending accounts (verification policy unsatisfied — correction spec
  // §17) NEVER receive organization data: the org context is the choke
  // point every org-scoped route goes through.
  if (resolved.user.status !== "ACTIVE") {
    throw new OrgContextError(
      403,
      "account_pending_verification",
      "Verify your email and phone to activate your account",
    );
  }

  const memberships: MembershipWithOrg[] = await db.membership.findMany({
    where: { userId: resolved.user.id },
    include: { organization: true },
    orderBy: { createdAt: "asc" },
  });
  if (memberships.length === 0) {
    // Legacy/repair path: a user without any membership gets a personal org
    // provisioned (same primitive as signup). This should not happen post-migration.
    const { ensurePersonalOrg } = await import("@/server/billing/org");
    const org = await ensurePersonalOrg(resolved.user);
    const membership = await db.membership.findUniqueOrThrow({
      where: { organizationId_userId: { organizationId: org.id, userId: resolved.user.id } },
      include: { organization: true },
    });
    memberships.push(membership);
  }

  const requestedOrgId = req.cookies.get(ORG_COOKIE)?.value;
  const active: MembershipWithOrg =
    (requestedOrgId ? memberships.find((m) => m.organizationId === requestedOrgId) : undefined) ??
    // Personal org (the one the user owns) first, then oldest membership.
    memberships.find((m) => m.organization.ownerUserId === resolved.user.id) ??
    memberships[0];

  return {
    user: resolved.user,
    organization: active.organization,
    membership: active,
    memberships: memberships.map((m) => ({ organization: m.organization, membership: m })),
    role: isOrgRole(active.role) ? active.role : "MEMBER",
  };
}

/**
 * Org context with a role floor. Central choke point for role authorization
 * (§25) — routes MUST use this instead of inline role checks.
 */
export async function requireOrgRole(req: NextRequest, min: OrgRole): Promise<OrgContext> {
  const ctx = await getOrgContext(req);
  if (!roleAtLeast(ctx.role, min)) {
    throw new OrgContextError(403, "forbidden", `Requires ${min} role in this organization`);
  }
  return ctx;
}

/** Validate an explicit organizationId path parameter against membership (§24: ID tampering). */
export async function requireOrgMember(req: NextRequest, organizationId: string, min: OrgRole = "MEMBER"): Promise<OrgContext> {
  const ctx = await getOrgContext(req);
  const target = ctx.memberships.find((m) => m.membership.organizationId === organizationId);
  if (!target) {
    // Deliberately 403 (not 404): the caller is authenticated but not allowed.
    throw new OrgContextError(403, "forbidden", "Not a member of this organization");
  }
  if (!roleAtLeast(target.membership.role, min)) {
    throw new OrgContextError(403, "forbidden", `Requires ${min} role in this organization`);
  }
  return {
    ...ctx,
    organization: target.organization,
    membership: target.membership,
    role: isOrgRole(target.membership.role) ? target.membership.role : "MEMBER",
  };
}

// ── Same-origin check for mutating requests (CSRF defence in depth) ──────
// The decision logic lives in @/server/origin (single source of truth,
// also used by the global src/proxy.ts gate which returns the proper 403).
// This in-handler layer stays as defence in depth for callers that reach
// the handler without the proxy gate (internal invocations, tests).

/**
 * Reject cross-site mutations before any state change. Combined with
 * SameSite=Lax cookies this closes classic CSRF (§33).
 */
export function assertSameOrigin(req: NextRequest): void {
  const mutating = req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS";
  if (!mutating) return;
  if (!isAllowedOrigin(req.headers.get("origin"), req)) {
    throw new OrgContextError(403, "csrf_rejected", "Cross-origin request rejected");
  }
}

// ── Signed OAuth state cookies (§10) ────────────────────────────────────

export function hmacSign(value: string): string {
  return createHmac("sha256", serverEnv.authSecret).update(value).digest("base64url");
}

/** value + "." + HMAC — tamper-proof cookie payloads (state/PKCE/link intent). */
export function signPayload(value: string): string {
  return `${value}.${hmacSign(value)}`;
}

export function verifySignedPayload(signed: string): string | null {
  const idx = signed.lastIndexOf(".");
  if (idx <= 0) return null;
  const value = signed.slice(0, idx);
  const mac = signed.slice(idx + 1);
  const expected = hmacSign(value);
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return value;
}

export { SESSION_COOKIE };
