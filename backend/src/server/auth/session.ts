/**
 * Dashboard sessions — opaque bearer tokens in an httpOnly cookie,
 * SHA-256 hashes stored in the database. Raw tokens never persisted.
 *
 * Phase 1 hardening (§8, §9, §33):
 *  - sessions carry lastUsedAt, revokedAt, IP and user-agent metadata
 *  - revocation (logout / password reset / explicit revoke) is enforced on
 *    EVERY authentication check — a stolen or revoked token grants nothing
 *  - a fresh random token is minted per login (session-fixation safe);
 *    tokens are never reused or "upgraded" in place
 *  - expired sessions are rejected and purged opportunistically
 *  - cookie: httpOnly, SameSite=Lax, Secure in production, path-scoped
 *    (SameSite=Lax + JSON-only mutations + same-origin checks = CSRF posture)
 */
import { createHash, randomBytes } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import type { Session, User } from "@prisma/client";

export const SESSION_COOKIE = "tf_session";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const LAST_USED_UPDATE_INTERVAL_MS = 60_000; // throttle lastUsedAt writes

export function createSessionToken(): { raw: string; tokenHash: string } {
  const raw = randomBytes(32).toString("base64url");
  return { raw, tokenHash: sha256(raw) };
}

export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export type CreateSessionOptions = {
  ipAddress?: string | null;
  userAgent?: string | null;
};

/** Mint a new session for a user. Always a brand-new token (fixation-safe). */
export async function createSession(userId: string, opts?: CreateSessionOptions): Promise<{ raw: string; expiresAt: Date }> {
  const { raw, tokenHash } = createSessionToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.session.create({
    data: {
      userId,
      tokenHash,
      expiresAt,
      lastUsedAt: new Date(),
      ipAddress: opts?.ipAddress ?? null,
      userAgent: opts?.userAgent ?? null,
    },
  });
  return { raw, expiresAt };
}

/** Attach the session cookie to a response. */
export function setSessionCookie(res: NextResponse, raw: string, expiresAt: Date): void {
  res.cookies.set(SESSION_COOKIE, raw, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    expires: expiresAt,
    path: "/",
  });
}

export function clearSessionCookie(res: NextResponse): void {
  res.cookies.set(SESSION_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 0,
    path: "/",
  });
}

export type ResolvedSession = { user: User; session: Session };

/**
 * Resolve the current user + session row from the session cookie, or null.
 *
 * Rejected (and null-returned) when: no cookie, unknown token hash, expired,
 * or revoked. Expired rows are deleted lazily on sight.
 * Updates lastUsedAt opportunistically (throttled) for the session UI.
 */
export async function getSessionUser(req: NextRequest): Promise<User | null> {
  const resolved = await resolveSession(req);
  return resolved?.user ?? null;
}

export async function resolveSession(req: NextRequest): Promise<ResolvedSession | null> {
  const raw = req.cookies.get(SESSION_COOKIE)?.value;
  if (!raw) return null;
  const tokenHash = sha256(raw);
  const session = await db.session.findUnique({
    where: { tokenHash },
    include: { user: true },
  });
  if (!session) return null;
  if (session.revokedAt) return null; // revoked sessions never authenticate (§9)
  if (session.expiresAt < new Date()) {
    await db.session.delete({ where: { id: session.id } }).catch(() => undefined);
    return null;
  }
  const user = session.user;
  // PENDING accounts authenticate (they must be able to complete email/phone
  // verification — correction spec §2/§17) but are gated from ALL
  // organization data via getOrgContext. SUSPENDED accounts are locked out
  // everywhere.
  if (user.status === "SUSPENDED") return null;
  if (Date.now() - session.lastUsedAt.getTime() > LAST_USED_UPDATE_INTERVAL_MS) {
    await db.session
      .update({ where: { id: session.id }, data: { lastUsedAt: new Date() } })
      .catch(() => undefined);
  }
  return { user, session };
}

/**
 * Logout / explicit revocation: mark revoked (row kept for audit + "reuse
 * after logout must fail" semantics, §33) instead of deleting.
 */
export async function revokeSession(req: NextRequest): Promise<void> {
  const raw = req.cookies.get(SESSION_COOKIE)?.value;
  if (!raw) return;
  await db.session
    .update({ where: { tokenHash: sha256(raw) }, data: { revokedAt: new Date() } })
    .catch(() => undefined);
}

export async function revokeSessionById(sessionId: string): Promise<void> {
  await db.session
    .update({ where: { id: sessionId }, data: { revokedAt: new Date() } })
    .catch(() => undefined);
}

/** Revoke every live session of a user (password reset, suspension, "sign out everywhere"). */
export async function revokeAllUserSessions(userId: string): Promise<number> {
  const res = await db.session.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return res.count;
}

/** Purge expired sessions (called opportunistically on login). */
export async function purgeExpiredSessions(): Promise<void> {
  await db.session.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  // Revoked rows are audit data; drop them once 90 days stale.
  const staleCutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  await db.session
    .deleteMany({ where: { revokedAt: { lt: staleCutoff } } })
    .catch(() => undefined);
}
