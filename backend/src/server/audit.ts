/**
 * Privileged-action audit trail (Phase 1 §41).
 *
 * Records WHO did WHAT to WHICH organization, with non-sensitive metadata.
 * NEVER log: passwords, password hashes, session tokens, OAuth codes or
 * tokens, API keys, Stripe/AWS secrets (§40). Callers pass ids only.
 *
 * Audit writes are best-effort: a failed audit insert must never break the
 * user-facing operation, but it is logged server-side for operators.
 */
import { db } from "@/lib/db";

export type AuditAction =
  | "signup"
  | "login"
  | "login_failed"
  | "logout"
  | "session_revoked"
  | "oauth_connect"
  | "oauth_auto_link"
  | "oauth_signin"
  | "oauth_unlink"
  | "oauth_link_refused"
  | "oauth_refused_unverified_email"
  | "password_change"
  | "password_reset_requested"
  | "password_reset_completed"
  | "email_verified"
  | "email_verification_sent"
  | "phone_verification_requested"
  | "phone_verified"
  | "phone_verification_refused"
  | "phone_removed"
  | "account_activated"
  | "invitation_created"
  | "invitation_accepted"
  | "invitation_revoked"
  | "member_removed"
  | "role_changed"
  | "organization_created"
  | "org_switched";

export async function recordAudit(entry: {
  action: AuditAction;
  userId?: string | null;
  organizationId?: string | null;
  metadata?: Record<string, unknown>;
  ipAddress?: string | null;
}): Promise<void> {
  try {
    await db.auditLog.create({
      data: {
        action: entry.action,
        userId: entry.userId ?? null,
        organizationId: entry.organizationId ?? null,
        metadata: entry.metadata ? JSON.stringify(entry.metadata) : null,
        ipAddress: entry.ipAddress ?? null,
      },
    });
  } catch (err) {
    console.error(
      `[audit] failed to record ${entry.action}: ${err instanceof Error ? err.message : err}`,
    );
  }
}
