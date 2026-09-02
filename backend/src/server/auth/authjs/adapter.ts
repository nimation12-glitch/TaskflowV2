/**
 * Auth.js database adapter over TaskFlow's EXISTING domain models
 * (correction spec §1: adopt the framework WITHOUT discarding the model).
 *
 * Mapping (no schema clobbering — deliberately NOT @auth/prisma-adapter):
 *   AdapterUser        → User                    (id, email, name, image→avatarUrl,
 *                                                 emailVerified→emailVerifiedAt)
 *   AdapterAccount     → AuthenticationIdentity  (provider+providerAccountId unique;
 *                                                 OAuth tokens are NOT persisted —
 *                                                 linkAccount drops them, Phase 1 §6)
 *   AdapterSession     → Session                 (tokenHash = sha256(token); revocation,
 *                                                 lastUsedAt, IP/UA preserved, §8)
 *
 * Session token handling: Auth.js generates a high-entropy token
 * (overridden to 32 random bytes — see authjs/index.ts), the adapter stores
 * ONLY its SHA-256 and returns the raw value for the cookie. Raw tokens are
 * never persisted (§8).
 *
 * createUser applies the account-status policy: a provider-verified email
 * activates the account; an unverified one leaves it PENDING for the
 * standard verification flow (correction spec §2, §17).
 */
import { randomBytes } from "crypto";
import type { Adapter, AdapterUser, AdapterAccount, AdapterSession } from "next-auth/adapters";
import { db } from "@/lib/db";
import { sha256 } from "@/server/auth/session";
import { canonicalProvider } from "./provider-map";
import { recordAudit } from "@/server/audit";

type Profileish = {
  email?: string | null;
  name?: string | null;
  image?: string | null;
  emailVerified?: Date | null;
  email_verified?: boolean | string | null;
};

/** Extract the verification state from either OIDC (`emailVerified`) or plain-OAuth (`email_verified`) profile shapes. */
export function profileEmailVerified(profile: Profileish): boolean {
  if (profile.emailVerified instanceof Date) return true;
  return profile.email_verified === true;
}

export function toAdapterUser(user: {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  emailVerifiedAt: Date | null;
}): AdapterUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    image: user.avatarUrl,
    emailVerified: user.emailVerifiedAt,
  };
}

export const taskflowAdapter: Adapter = {
  async createUser(profile) {
    const email = profile.email?.toLowerCase();
    if (!email) throw new Error("Auth.js createUser requires an email");
    const verifiedAt = profile.emailVerified instanceof Date ? profile.emailVerified : profileEmailVerified(profile) ? new Date() : null;
    const created = await db.user.create({
      data: {
        email,
        name: profile.name ?? email.split("@")[0],
        avatarUrl: profile.image ?? null,
        emailVerifiedAt: verifiedAt,
        // Provider-verified email → ACTIVE (provider is the anti-abuse
        // control); unverified → PENDING until email+phone verification.
        status: verifiedAt ? "ACTIVE" : "PENDING",
        lastLoginAt: new Date(),
      },
    });
    return toAdapterUser(created);
  },

  async getUser(id) {
    const user = await db.user.findUnique({ where: { id } });
    return user ? toAdapterUser(user) : null;
  },

  async getUserByEmail(email) {
    const user = await db.user.findUnique({ where: { email: email.toLowerCase() } });
    return user ? toAdapterUser(user) : null;
  },

  async getUserByAccount({ provider, providerAccountId }) {
    const canonical = canonicalProvider(provider);
    if (!canonical) return null;
    const identity = await db.authenticationIdentity.findUnique({
      where: { provider_providerAccountId: { provider: canonical, providerAccountId } },
      include: { user: true },
    });
    return identity ? toAdapterUser(identity.user) : null;
  },

  async updateUser({ id, name, email, emailVerified, image }) {
    const updated = await db.user.update({
      where: { id },
      data: {
        ...(name !== undefined ? { name } : {}),
        // Email updates through Auth.js are only honored when there is no
        // conflicting local account — email is the identity anchor (§4).
        ...(email !== undefined ? { email: email.toLowerCase() } : {}),
        // Verification can be UPGRADED by a provider-verified claim but is
        // never downgraded to null (§7 old spec).
        ...(emailVerified !== undefined ? { emailVerifiedAt: emailVerified ?? undefined } : {}),
        ...(image !== undefined ? { avatarUrl: image } : {}),
      },
    });
    return toAdapterUser(updated);
  },

  async linkAccount(account) {
    const canonical = canonicalProvider(account.provider);
    if (!canonical) throw new Error(`Unsupported OAuth provider: ${account.provider}`);

    const clash = await db.authenticationIdentity.findUnique({
      where: { provider_providerAccountId: { provider: canonical, providerAccountId: account.providerAccountId } },
    });
    if (clash) {
      if (clash.userId === account.userId) return; // idempotent re-link (§32)
      // A linked identity belongs to exactly one TaskFlow user, ever
      // (correction spec §4/§6).
      throw new Error("identity_taken");
    }

    await db.authenticationIdentity.create({
      data: {
        userId: account.userId,
        provider: canonical,
        providerAccountId: account.providerAccountId,
      },
    });
    // Provider tokens (access/refresh) are intentionally dropped here —
    // identity-only linking, nothing sensitive persists (Phase 1 §6, §40).
    await recordAudit({
      action: "oauth_connect",
      userId: account.userId,
      metadata: { provider: canonical, via: "authjs_link_account" },
    });
  },

  async createSession({ sessionToken, userId, expires }) {
    // IP/UA come from the request-scoped context (Auth.js adapters receive
    // no request — see auth-context.ts).
    const { getAuthContext } = await import("@/server/auth/auth-context");
    const ctx = getAuthContext();
    await db.session.create({
      data: {
        userId,
        tokenHash: sha256(sessionToken),
        expiresAt: expires,
        lastUsedAt: new Date(),
        ipAddress: ctx.ipAddress ?? null,
        userAgent: ctx.userAgent ?? null,
      },
    });
    // The RAW token goes back for the cookie; only the hash is stored.
    const session: AdapterSession = { sessionToken, userId, expires };
    return session;
  },

  async getSessionAndUser(sessionToken) {
    const session = await db.session.findUnique({
      where: { tokenHash: sha256(sessionToken) },
      include: { user: true },
    });
    if (!session) return null;
    if (session.revokedAt) return null; // revoked sessions never authenticate (§8/§9)
    if (session.expiresAt < new Date()) {
      await db.session.delete({ where: { id: session.id } }).catch(() => undefined);
      return null;
    }
    return {
      session: { sessionToken, userId: session.userId, expires: session.expiresAt },
      user: toAdapterUser(session.user),
    };
  },

  async updateSession({ sessionToken, expires }) {
    const updated = await db.session
      .update({
        where: { tokenHash: sha256(sessionToken) },
        data: {
          ...(expires ? { expiresAt: expires } : {}),
          lastUsedAt: new Date(),
        },
      })
      .catch(() => null);
    if (!updated) return null;
    return { sessionToken, userId: updated.userId, expires: expires ?? updated.expiresAt };
  },

  async deleteSession(sessionToken) {
    // Revocation (not deletion) preserves the "reuse after logout fails"
    // audit semantics (§9, §33).
    await db.session
      .update({ where: { tokenHash: sha256(sessionToken) }, data: { revokedAt: new Date() } })
      .catch(() => undefined);
  },

  // Verification-token adapter methods exist for the Auth.js Email provider,
  // which TaskFlow does not use — our own AuthToken/phone-challenge system
  // handles verification (correction spec §2). Fail loudly if ever invoked.
  async createVerificationToken() {
    throw new Error("Auth.js Email provider is not used by TaskFlow; verification tokens are handled internally");
  },
  async useVerificationToken() {
    throw new Error("Auth.js Email provider is not used by TaskFlow; verification tokens are handled internally");
  },
};

/**Entropy helper kept next to the adapter that consumes it (see index.ts). */
export function generateSessionToken(): string {
  return randomBytes(32).toString("base64url");
}
