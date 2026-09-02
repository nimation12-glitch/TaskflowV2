/**
 * Organization invitations (Phase 1 §19–§21).
 *
 * Security properties:
 *  - invitation tokens: 32 random bytes (base64url), ONLY the SHA-256 hash
 *    is stored; the raw token lives exclusively in the emailed link
 *  - expiry (7 days) + single-use acceptance (acceptedAt first-writer-wins)
 *  - explicit revocation by an OWNER/ADMIN
 *  - seat limit comes from the org's PLAN (Plan.maxMembers, §20) and counts
 *    ACTIVE memberships + PENDING invitations — server-enforced
 *  - acceptance authorizes joining by the invitation ITSELF: the accepting
 *    account must control the invited email address (§21) — membership is
 *    never granted just because an email looks the same
 *  - OWNER role is never granted through an invitation (ADMIN max)
 */
import { randomBytes } from "crypto";
import { db } from "@/lib/db";
import { recordAudit } from "@/server/audit";
import { appLink, emailTemplates, sendEmail } from "@/server/email";

export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export class InvitationError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "InvitationError";
  }
}

export type SeatUsage = { used: number; limit: number };
/** Map a thrown InvitationError (or unknown) to a JSON response. */
export function invitationErrorResponse(err: unknown): { status: number; message: string } {
  if (err instanceof InvitationError) return { status: err.status, message: err.message };
  throw err;
}


/**
 * Seat accounting (§20): active memberships + pending invitations against
 * the organization's plan limit (DB-backed — never hardcoded).
 */
export async function getSeatUsage(organizationId: string): Promise<SeatUsage> {
  const org = await db.organization.findUnique({
    where: { id: organizationId },
    include: { subscription: { include: { plan: true } } },
  });
  if (!org) throw new InvitationError(404, "org_not_found", "Organization not found");
  const limit = org.subscription?.plan.maxMembers ?? 3;
  const [members, pending] = await Promise.all([
    db.membership.count({ where: { organizationId } }),
    db.invitation.count({
      where: { organizationId, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
    }),
  ]);
  return { used: members + pending, limit };
}

export async function createInvitation(opts: {
  organizationId: string;
  invitedBy: { id: string; email: string; name: string | null };
  email: string;
  role: "ADMIN" | "MEMBER";
  ipAddress?: string | null;
}): Promise<{ rawToken: string; expiresAt: Date }> {
  const email = opts.email.toLowerCase();

  const [org, existingUser, seat] = await Promise.all([
    db.organization.findUnique({ where: { id: opts.organizationId } }),
    db.user.findUnique({ where: { email } }),
    getSeatUsage(opts.organizationId),
  ]);
  if (!org) throw new InvitationError(404, "org_not_found", "Organization not found");
  if (seat.used >= seat.limit) {
    throw new InvitationError(
      403,
      "seat_limit_reached",
      `Seat limit reached (${seat.used}/${seat.limit}). Upgrade the plan or revoke a pending invitation.`,
    );
  }
  if (existingUser) {
    const existingMember = await db.membership.findUnique({
      where: { organizationId_userId: { organizationId: opts.organizationId, userId: existingUser.id } },
    });
    if (existingMember) {
      throw new InvitationError(409, "already_member", "This user is already a member of the organization");
    }
  }
  const duplicate = await db.invitation.findFirst({
    where: { organizationId: opts.organizationId, invitedEmail: email, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
  });
  if (duplicate) {
    throw new InvitationError(409, "already_invited", "An invitation for this email is already pending");
  }

  const rawToken = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);
  const invitation = await db.invitation.create({
    data: {
      organizationId: opts.organizationId,
      invitedEmail: email,
      invitedByUserId: opts.invitedBy.id,
      role: opts.role,
      tokenHash: (await import("@/server/auth/session")).sha256(rawToken),
      expiresAt,
    },
  });

  await recordAudit({
    action: "invitation_created",
    userId: opts.invitedBy.id,
    organizationId: opts.organizationId,
    metadata: { invitationId: invitation.id, role: opts.role },
    ipAddress: opts.ipAddress ?? null,
  });

  // Email best-effort: the token exists regardless; a delivery failure is
  // visible in the outbox and the inviting member can re-send by re-inviting
  // after revocation. Never expose the raw token in API responses (§19) —
  // except the single creation response to the AUTHORIZED admin (the UI
  // shows a copyable link when email delivery is not configured).
  const link = appLink("/invite", rawToken);
  const template = emailTemplates.organizationInvitation(org.name, link);
  const sent = await sendEmail({ to: email, ...template });
  if (!sent.ok) {
    console.warn(`[invitations] delivery failed for invitation ${invitation.id}: ${sent.error}`);
  }

  return { rawToken, expiresAt };
}

export type InvitationLookup = {
  organizationName: string;
  invitedEmail: string;
  role: string;
  expiresAt: Date;
  /** Does the given (signed-in or registering) email match the invitation? */
  emailMatches: (email: string | null | undefined) => boolean;
};

/** Token lookup for the accept screen — safe fields only, never the hash. */
export async function lookupInvitation(rawToken: string): Promise<InvitationLookup> {
  const { sha256 } = await import("@/server/auth/session");
  const invitation = await db.invitation.findUnique({
    where: { tokenHash: sha256(rawToken) },
    include: { organization: true },
  });
  if (!invitation) throw new InvitationError(404, "invalid_token", "This invitation link is not valid");
  if (invitation.revokedAt) throw new InvitationError(410, "revoked", "This invitation was revoked");
  if (invitation.acceptedAt) throw new InvitationError(410, "already_accepted", "This invitation was already accepted");
  if (invitation.expiresAt < new Date()) throw new InvitationError(410, "expired", "This invitation has expired");
  if (invitation.organization.status !== "ACTIVE") {
    throw new InvitationError(403, "org_inactive", "This organization is not accepting members");
  }
  return {
    organizationName: invitation.organization.name,
    invitedEmail: invitation.invitedEmail,
    role: invitation.role,
    expiresAt: invitation.expiresAt,
    emailMatches: (email) => Boolean(email && email.toLowerCase() === invitation.invitedEmail),
  };
}

/**
 * Accept an invitation: full validation chain (§21) then membership creation +
 * invalidation in one transaction. Returns the organization for redirect.
 */
export async function acceptInvitation(opts: {
  rawToken: string;
  user: { id: string; email: string };
  ipAddress?: string | null;
}): Promise<{ organizationId: string; organizationName: string; role: string }> {
  const { sha256 } = await import("@/server/auth/session");
  const invitation = await db.invitation.findUnique({
    where: { tokenHash: sha256(opts.rawToken) },
    include: { organization: { include: { subscription: { include: { plan: true } } } } },
  });
  if (!invitation) throw new InvitationError(404, "invalid_token", "This invitation link is not valid");
  if (invitation.revokedAt) throw new InvitationError(410, "revoked", "This invitation was revoked");
  if (invitation.acceptedAt) throw new InvitationError(410, "already_accepted", "This invitation was already accepted");
  if (invitation.expiresAt < new Date()) throw new InvitationError(410, "expired", "This invitation has expired");
  if (invitation.organization.status !== "ACTIVE") {
    throw new InvitationError(403, "org_inactive", "This organization is not accepting members");
  }

  // Email ownership: the accepting account must control the invited address.
  if (opts.user.email.toLowerCase() !== invitation.invitedEmail) {
    throw new InvitationError(
      403,
      "email_mismatch",
      `This invitation was sent to ${invitation.invitedEmail}. Sign in or register with that address to accept it.`,
    );
  }

  // Already a member? Invalidate the invitation, report success-ish (idempotent UX).
  const existingMembership = await db.membership.findUnique({
    where: { organizationId_userId: { organizationId: invitation.organizationId, userId: opts.user.id } },
  });
  if (existingMembership) {
    await db.invitation.update({
      where: { id: invitation.id },
      data: { acceptedAt: new Date() },
    });
    return {
      organizationId: invitation.organizationId,
      organizationName: invitation.organization.name,
      role: existingMembership.role,
    };
  }

  // Seat availability re-checked atomically with membership creation.
  // The invitation being accepted converts into a member seat, so it is
  // excluded from the pending count (otherwise the last valid seat could
  // never be claimed).
  const [members, pendingOthers] = await Promise.all([
    db.membership.count({ where: { organizationId: invitation.organizationId } }),
    db.invitation.count({
      where: {
        organizationId: invitation.organizationId,
        id: { not: invitation.id },
        acceptedAt: null,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
    }),
  ]);
  const limit = invitation.organization.subscription?.plan.maxMembers ?? 3;
  if (members + pendingOthers >= limit) {
    throw new InvitationError(403, "seat_limit_reached", `Seat limit reached (${members + pendingOthers}/${limit}).`);
  }

  await db.$transaction([
    db.membership.create({
      data: {
        organizationId: invitation.organizationId,
        userId: opts.user.id,
        role: invitation.role,
        invitedByUserId: invitation.invitedByUserId,
      },
    }),
    db.invitation.update({ where: { id: invitation.id }, data: { acceptedAt: new Date() } }),
  ]);

  await recordAudit({
    action: "invitation_accepted",
    userId: opts.user.id,
    organizationId: invitation.organizationId,
    metadata: { invitationId: invitation.id, role: invitation.role },
    ipAddress: opts.ipAddress ?? null,
  });

  return {
    organizationId: invitation.organizationId,
    organizationName: invitation.organization.name,
    role: invitation.role,
  };
}

export async function revokeInvitation(invitationId: string, organizationId: string, actingUserId: string): Promise<void> {
  const invitation = await db.invitation.findUnique({ where: { id: invitationId } });
  if (!invitation || invitation.organizationId !== organizationId) {
    throw new InvitationError(404, "not_found", "Invitation not found");
  }
  if (invitation.acceptedAt) throw new InvitationError(409, "already_accepted", "Invitation already accepted");
  await db.invitation.update({ where: { id: invitation.id }, data: { revokedAt: new Date() } });
  await recordAudit({
    action: "invitation_revoked",
    userId: actingUserId,
    organizationId,
    metadata: { invitationId },
  });
}
