/**
 * Authentication endpoint rate limiting (Phase 1 §34).
 *
 * In-memory sliding windows keyed by bucket (typically ip / ip+email) —
 * same single-instance trade-off as the gateway limiter (swap for Redis at
 * scale; interface unchanged). Protects against password spraying, credential
 * stuffing, invitation-token guessing and verification-token spam.
 *
 * Buckets are namespaced by route so limits don't interfere.
 */
import { NextRequest } from "next/server";

type Window = { timestamps: number[] };

const windows = new Map<string, Window>();
let lastGc = Date.now();

function gc(now: number): void {
  if (now - lastGc < 60_000) return;
  lastGc = now;
  for (const [key, win] of windows) {
    if (win.timestamps.length === 0 || now - win.timestamps[win.timestamps.length - 1] > 15 * 60_000) {
      windows.delete(key);
    }
  }
}

export type AuthRateLimitResult = {
  allowed: boolean;
  retryAfterSeconds: number;
};

/** Consume one slot in a sliding window. Returns allowed=false when exceeded. */
export function checkAuthRateLimit(bucket: string, limit: number, windowMs: number): AuthRateLimitResult {
  const now = Date.now();
  gc(now);
  const win = windows.get(bucket) ?? { timestamps: [] };
  win.timestamps = win.timestamps.filter((t) => now - t < windowMs);
  if (win.timestamps.length >= limit) {
    windows.set(bucket, win);
    const oldest = win.timestamps[0];
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((oldest + windowMs - now) / 1000)) };
  }
  win.timestamps.push(now);
  windows.set(bucket, win);
  return { allowed: true, retryAfterSeconds: 0 };
}

/** Best-effort client IP for rate limiting / audit (behind the Caddy gateway). */
export function clientIp(req: NextRequest): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return req.headers.get("x-real-ip") ?? "unknown";
}

/**
 * Named limit presets (§34). Email-scoped buckets normalize the address so
 * `Foo@x.com` and `foo@x.com` share a bucket.
 */
export const AUTH_LIMITS = {
  /** per IP per 10 min — account spam / signup abuse */
  register: { limit: 8, windowMs: 10 * 60_000 },
  /** per IP per min + per IP+email per min — password spraying */
  loginIp: { limit: 20, windowMs: 60_000 },
  loginEmail: { limit: 8, windowMs: 60_000 },
  /** per IP per 10 min + per email — token spam / enumeration probing */
  passwordReset: { limit: 5, windowMs: 10 * 60_000 },
  passwordResetEmail: { limit: 3, windowMs: 10 * 60_000 },
  /** per IP per min — verification resend */
  emailVerify: { limit: 5, windowMs: 60_000 },
  /** per IP per min — OAuth initiation */
  oauthStart: { limit: 20, windowMs: 60_000 },
  /** per user per 10 min — SMS code requests (per-IP bucket uses the same preset) */
  smsRequest: { limit: 3, windowMs: 10 * 60_000 },
  /** per IP per 10 min — SMS code requests */
  smsRequestIp: { limit: 10, windowMs: 10 * 60_000 },
  /** per user per 10 min — SMS code confirmations (challenge attempts ≤ 5) */
  smsConfirm: { limit: 10, windowMs: 10 * 60_000 },
  /** per IP per 10 min — invitation token guessing */
  invitationAccept: { limit: 20, windowMs: 10 * 60_000 },
} as const;

export function limitOr429(
  bucket: string,
  preset: { limit: number; windowMs: number },
): AuthRateLimitResult {
  return checkAuthRateLimit(bucket, preset.limit, preset.windowMs);
}

/**
 * Login rate limits (per-IP + per-IP+email) shared by the /api/auth/login
 * route and the Auth.js credentials framework path — the SAME sliding
 * window, so limits cannot be bypassed by switching entry points (§19).
 */
export function checkLoginRateLimits(
  ip: string,
  email: string,
): AuthRateLimitResult {
  const rlIp = checkAuthRateLimit(`login:ip:${ip}`, AUTH_LIMITS.loginIp.limit, AUTH_LIMITS.loginIp.windowMs);
  const rlEmail = checkAuthRateLimit(
    `login:email:${ip}:${email.toLowerCase()}`,
    AUTH_LIMITS.loginEmail.limit,
    AUTH_LIMITS.loginEmail.windowMs,
  );
  if (!rlIp.allowed || !rlEmail.allowed) {
    return { allowed: false, retryAfterSeconds: Math.max(rlIp.retryAfterSeconds, rlEmail.retryAfterSeconds) };
  }
  return { allowed: true, retryAfterSeconds: 0 };
}
