/**
 * Authentication identity management (correction spec §6).
 *
 * With Auth.js owning the OAuth protocol, linking happens natively in the
 * framework callback (sign-in / auto-link / explicit connect are all
 * policy-gated — see authjs/policy.ts). This module keeps the explicit
 * UNLINK flow with lock-out protection: the last usable credential
 * (password OR ≥1 connected identity) can never be removed, so an account
 * can always be signed into.
 */
import { db } from "@/lib/db";
import { recordAudit } from "@/server/audit";

export class IdentityError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "IdentityError";
  }
}

/** Unlink with lock-out protection: at least one credential must remain (§6). */
export async function unlinkIdentity(userId: string, identityId: string, ip: string | null): Promise<void> {
  const identity = await db.authenticationIdentity.findUnique({ where: { id: identityId } });
  if (!identity || identity.userId !== userId) {
    throw new IdentityError(404, "not_found", "Identity not found");
  }
  const [credential, otherIdentities] = await Promise.all([
    db.passwordCredential.findUnique({ where: { userId } }),
    db.authenticationIdentity.count({ where: { userId, id: { not: identityId } } }),
  ]);
  if (!credential && otherIdentities === 0) {
    throw new IdentityError(
      409,
      "last_credential",
      "Cannot remove your only sign-in method. Add a password or another provider first.",
    );
  }
  await db.authenticationIdentity.delete({ where: { id: identityId } });
  await recordAudit({ action: "oauth_unlink", userId, metadata: { provider: identity.provider }, ipAddress: ip });
}
