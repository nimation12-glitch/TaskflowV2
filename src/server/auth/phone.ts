/**
 * Phone verification service (correction spec §3).
 *
 * Flow: user submits a phone number → a 6-digit CSPRNG code is issued →
 * an SMS is sent through the pluggable SmsProvider → the user submits the
 * code → on success phoneVerifiedAt is set and the pending-account
 * activation policy is applied.
 *
 * Challenge security:
 *  - codes are 6 digits from crypto.randomInt — 10^6 entropy per attempt,
 *    attempts are CAPPED (5 per challenge) so brute force is hopeless
 *  - only HMAC-SHA256(AUTH_SECRET, challengeId:code) is stored — raw codes
 *    never reach the database (AUTH_SECRET leaks ≠ offline verification)
 *  - challenges expire after 10 minutes and are single-use (consumedAt,
 *    first-writer-wins update under concurrency)
 *  - a new challenge invalidates outstanding ones for the same user
 *  - rate limits live in the routes (per-user + per-IP, AUTH_LIMITS)
 *
 * Privacy: full phone numbers are NEVER logged; logs use maskPhone().
 * Codes are logged nowhere; only the dev/test SMS outbox persists bodies.
 */
import { createHmac, randomInt } from "crypto";
import { db } from "@/lib/db";
import { serverEnv } from "@/server/env";
import { sendSms } from "@/server/sms";
import { recordAudit } from "@/server/audit";

export const PHONE_CHALLENGE_TTL_MS = 10 * 60 * 1000;
export const PHONE_MAX_ATTEMPTS = 5;

/**
 * Normalize a phone number to strict E.164: strip separators, require
 * `+` + country code + 8–15 digits (ITU-T E.164). Returns null when the
 * input cannot be interpreted — callers surface a validation error.
 */
export function normalizePhone(input: string): string | null {
  const trimmed = input.trim().replace(/[\s\-().]/g, "");
  const withPlus = trimmed.startsWith("+") ? trimmed : `+${trimmed}`;
  return /^\+[1-9]\d{7,14}$/.test(withPlus) ? withPlus : null;
}

/** Log-safe rendering: +441234567890 → +44****7890 (never a full number). */
export function maskPhone(phone: string): string {
  if (phone.length <= 5) return "+***********";
  return `${phone.slice(0, 3)}****${phone.slice(-4)}`;
}

function hmac(value: string): string {
  return createHmac("sha256", serverEnv.authSecret).update(value).digest("hex");
}

function hashCode(challengeId: string, code: string): string {
  return hmac(`phone-challenge:${challengeId}:${code}`);
}

export type IssueChallengeResult =
  | { ok: true; phone: string; transport: string; smsAccepted: boolean; smsError?: string }
  | { ok: false; reason: "invalid_phone" | "sms_not_configured" };

/**
 * Issue (and SMS) a fresh verification code. Invalidates outstanding
 * challenges for the user. Returns a TRUTHFUL delivery outcome — the UI
 * distinguishes "code sent" from "SMS provider not configured" (§12/§16).
 */
export async function issuePhoneChallenge(userId: string, rawPhone: string, opts?: { ip?: string | null }): Promise<IssueChallengeResult> {
  const phone = normalizePhone(rawPhone);
  if (!phone) return { ok: false, reason: "invalid_phone" };

  const provider = (await import("@/server/sms")).getSmsProvider();
  if (!provider.configured) {
    return { ok: false, reason: "sms_not_configured" };
  }

  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const row = await db.$transaction(async (tx) => {
    await tx.phoneVerificationChallenge.deleteMany({ where: { userId } });
    return tx.phoneVerificationChallenge.create({
      data: {
        userId,
        phone,
        // codeHash is unique; bind it to the challenge id so identical codes
        // across challenges produce different hashes.
        codeHash: "pending",
        expiresAt: new Date(Date.now() + PHONE_CHALLENGE_TTL_MS),
      },
    });
  });
  const codeHash = hashCode(row.id, code);
  await db.phoneVerificationChallenge.update({ where: { id: row.id }, data: { codeHash } });

  const sms = await sendSms(
    { to: phone, body: `Your TaskFlow verification code is ${code}. It expires in 10 minutes. If you didn't request it, ignore this message.` },
    // Production outbox rows never contain the code.
    { recordBody: `TaskFlow verification code sent (${maskPhone(phone)})` },
  );

  await recordAudit({
    action: "phone_verification_requested",
    userId,
    metadata: { phone: maskPhone(phone), transport: sms.transport, delivered: sms.ok },
    ipAddress: opts?.ip ?? null,
  });

  return {
    ok: true,
    phone,
    transport: sms.transport,
    smsAccepted: sms.ok,
    ...(sms.ok ? {} : { smsError: sms.error }),
  };
}

export type ConsumeChallengeResult =
  | { ok: true; phone: string }
  | { ok: false; reason: "no_challenge" | "invalid_code" | "expired" | "too_many_attempts" };

/**
 * Verify a submitted code against the user's outstanding challenge.
 * Single-use + expiring + attempt-limited. Invalid attempts INCREMENT the
 * attempt counter (brute-force ceiling); a consumed/expired challenge is
 * rejected regardless of the code.
 */
export async function consumePhoneChallenge(userId: string, code: string): Promise<ConsumeChallengeResult> {
  const normalized = code.trim();
  if (!/^\d{6}$/.test(normalized)) return { ok: false, reason: "invalid_code" };

  const row = await db.phoneVerificationChallenge.findFirst({
    where: { userId },
    orderBy: { createdAt: "desc" },
  });
  if (!row || row.consumedAt) return { ok: false, reason: "no_challenge" };
  if (row.expiresAt < new Date()) return { ok: false, reason: "expired" };
  if (row.attempts >= PHONE_MAX_ATTEMPTS) return { ok: false, reason: "too_many_attempts" };

  if (row.codeHash === "pending" || row.codeHash !== hashCode(row.id, normalized)) {
    await db.phoneVerificationChallenge.update({
      where: { id: row.id },
      data: { attempts: { increment: 1 } },
    });
    return { ok: false, reason: "invalid_code" };
  }

  // First-writer-wins consumption (replay-safe under concurrency).
  const consumed = await db.phoneVerificationChallenge.updateMany({
    where: { id: row.id, consumedAt: null },
    data: { consumedAt: new Date() },
  });
  if (consumed.count === 0) return { ok: false, reason: "no_challenge" };

  return { ok: true, phone: row.phone };
}

/**
 * Mark a phone as verified with VERIFIED-PHONE UNIQUENESS (correction spec
 * §4): no OTHER user may already hold this exact verified number. Enforced
 * transactionally (SQLite lacks partial unique indexes via db push). The
 * verification code for the NEW number is always required first — claiming
 * someone else's number requires receiving their SMS.
 *
 * `reverify` = the user is re-confirming a NEW number on an already-active
 * account: the account stays ACTIVE but the new number is unverified until
 * this call succeeds.
 */
export async function markPhoneVerified(userId: string, phone: string, opts?: { ip?: string | null }): Promise<{ ok: true } | { ok: false; reason: "phone_in_use" }> {
  const clash = await db.user.findFirst({
    where: { phone, phoneVerifiedAt: { not: null }, id: { not: userId } },
    select: { id: true },
  });
  if (clash) return { ok: false, reason: "phone_in_use" };

  try {
    await db.$transaction(async (tx) => {
      // Re-check inside the transaction (SQLite serializes writes — this
      // closes the check-then-act window between the two users).
      const stillClash = await tx.user.findFirst({
        where: { phone, phoneVerifiedAt: { not: null }, id: { not: userId } },
        select: { id: true },
      });
      if (stillClash) throw new Error("phone_in_use");
      await tx.user.update({
        where: { id: userId },
        data: { phone, phoneVerifiedAt: new Date() },
      });
    });
  } catch {
    return { ok: false, reason: "phone_in_use" };
  }

  await recordAudit({
    action: "phone_verified",
    userId,
    metadata: { phone: maskPhone(phone) },
    ipAddress: opts?.ip ?? null,
  });
  return { ok: true };
}

/** Remove a verified phone (account-page management). */
export async function clearPhone(userId: string): Promise<void> {
  await db.user.update({
    where: { id: userId },
    data: { phone: null, phoneVerifiedAt: null },
  });
  await recordAudit({ action: "phone_removed", userId, ipAddress: null });
}
