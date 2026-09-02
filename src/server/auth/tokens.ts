/**
 * Single-use, expiring, hashed account tokens (Phase 1 §5, §19).
 *
 * EMAIL_VERIFY and PASSWORD_RESET tokens:
 *   - 32 cryptographically random bytes, base64url — high-entropy, unguessable
 *   - only the SHA-256 hash is stored; the raw token lives exclusively in
 *     the emailed link
 *   - consumed exactly once (usedAt set transactionally on first use)
 *   - expiring: email verification 24 h, password reset 1 h
 *   - issuing a new token invalidates prior outstanding ones of the same type
 */
import { randomBytes } from "crypto";
import { db } from "@/lib/db";
import { sha256 } from "@/server/auth/session";

export const EMAIL_VERIFY_TTL_MS = 24 * 60 * 60 * 1000;
export const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000;

export type AuthTokenType = "EMAIL_VERIFY" | "PASSWORD_RESET";

function rawToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Issue a fresh token, invalidating any outstanding token of the same type. */
export async function issueAuthToken(
  userId: string,
  type: AuthTokenType,
  ttlMs: number,
): Promise<string> {
  const raw = rawToken();
  await db.$transaction([
    db.authToken.deleteMany({ where: { userId, type } }),
    db.authToken.create({
      data: {
        userId,
        type,
        tokenHash: sha256(raw),
        expiresAt: new Date(Date.now() + ttlMs),
      },
    }),
  ]);
  return raw;
}

export type ConsumeResult =
  | { ok: true; userId: string; type: AuthTokenType }
  | { ok: false; reason: "invalid" | "expired" | "used" };

/**
 * Atomically consume a token. Re-played tokens return used — a token can
 * never be redeemed twice (invitation/token-reuse audit item, §33).
 */
export async function consumeAuthToken(raw: string, type: AuthTokenType): Promise<ConsumeResult> {
  const row = await db.authToken.findUnique({ where: { tokenHash: sha256(raw) } });
  if (!row || row.type !== type) return { ok: false, reason: "invalid" };
  if (row.usedAt) return { ok: false, reason: "used" };
  if (row.expiresAt < new Date()) return { ok: false, reason: "expired" };

  const updated = await db.authToken.updateMany({
    where: { id: row.id, usedAt: null }, // first-writer-wins under concurrency
    data: { usedAt: new Date() },
  });
  if (updated.count === 0) return { ok: false, reason: "used" };
  return { ok: true, userId: row.userId, type };
}

export async function issueEmailVerificationToken(userId: string): Promise<string> {
  return issueAuthToken(userId, "EMAIL_VERIFY", EMAIL_VERIFY_TTL_MS);
}

export async function issuePasswordResetToken(userId: string): Promise<string> {
  return issueAuthToken(userId, "PASSWORD_RESET", PASSWORD_RESET_TTL_MS);
}
