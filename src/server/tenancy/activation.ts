/**
 * Account activation & provisioning (correction spec §2, §9, §17).
 *
 * VERIFICATION POLICY
 *   email/password accounts: PENDING until the email is verified AND the
 *     phone is verified. Activation is what provisions the workspace —
 *     the organization is NOT fully usable before verification (§17).
 *   OAuth accounts: the provider vouches for the identity; a provider-
 *     VERIFIED email activates the account on first sign-in. A provider
 *     account with an unverified email yields a PENDING user who completes
 *     the standard verification flow.
 *   OAuth accounts are exempt from phone verification (their anti-abuse
 *     control is the provider identity itself).
 *
 * The provisioning chain is the SHARED createOrganization path (§9/§32):
 *   Organization + OWNER Membership + Free Subscription + Credit Account
 *   — transactional, idempotent, and identical for registration, OAuth
 *   provisioning and the "create workspace" dialog. Repeated callbacks or
 *   double activation can never duplicate any row.
 */
import { db } from "@/lib/db";
import { ensurePersonalOrg } from "@/server/tenancy/org-service";
import { recordAudit } from "@/server/audit";

/**
 * Is the verification policy satisfied for this user?
 *   - every account: email must be verified
 *   - email/password accounts: the phone must ALSO be verified (§2/§3)
 *   - OAuth-only accounts: the provider identity is the anti-abuse control —
 *     no phone requirement
 */
export async function verificationPolicySatisfied(userId: string): Promise<boolean> {
  const user = await db.user.findUnique({
    where: { id: userId },
    include: { passwordCredential: { select: { id: true } } },
  });
  if (!user || user.status === "SUSPENDED") return false;
  if (!user.emailVerifiedAt) return false;
  if (user.status === "ACTIVE") return true;
  if (user.passwordCredential && !user.phoneVerifiedAt) return false;
  return true;
}

/**
 * Activate a PENDING user once the verification policy is satisfied and
 * provision their personal organization through the shared path.
 * Idempotent: safe to call on every verification event / sign-in.
 */
export async function activateUserIfEligible(
  userId: string,
  opts?: { ip?: string | null; trigger?: string },
): Promise<{ activated: boolean }> {
  const user = await db.user.findUnique({ where: { id: userId } });
  if (!user) return { activated: false };
  if (user.status !== "PENDING") return { activated: false };
  if (!(await verificationPolicySatisfied(userId))) return { activated: false };

  await db.user.update({ where: { id: user.id }, data: { status: "ACTIVE" } });
  await recordAudit({
    action: "account_activated",
    userId: user.id,
    metadata: { trigger: opts?.trigger ?? "verification_completed" },
    ipAddress: opts?.ip ?? null,
  });
  await ensureUserProvisioned(user.id, opts);
  return { activated: true };
}

/**
 * Guarantee the ACTIVE user owns a personal organization (org + OWNER
 * membership + Free subscription + credit account). Idempotent — the OAuth
 * sign-in path calls this on EVERY sign-in (§32: repeated callbacks never
 * duplicate organizations). PENDING/SUSPENDED users are never provisioned.
 */
export async function ensureUserProvisioned(
  userId: string,
  opts?: { ip?: string | null },
): Promise<void> {
  const user = await db.user.findUnique({ where: { id: userId } });
  if (!user || user.status !== "ACTIVE") return;

  const existing = await db.organization.findFirst({ where: { ownerUserId: user.id } });
  if (existing) return;
  await ensurePersonalOrg(user);
  await recordAudit({
    action: "organization_created",
    userId: user.id,
    metadata: { personal: true, via: "activation_provisioning" },
    ipAddress: opts?.ip ?? null,
  });
}
