/**
 * Auth.js sign-in policy (correction spec §4, §5, §6, §16).
 *
 * THE account-linking policy — enforced SERVER-SIDE inside the Auth.js
 * signIn callback, checked in order:
 *
 *   1. Identity already linked + anonymous visitor        → sign that user in.
 *   2. Identity already linked + signed in as SAME user   → no-op sign-in.
 *   3. Identity already linked + signed in as OTHER user  → REFUSE
 *      ("identity_taken") — connecting an already-bound provider can never
 *      silently switch accounts (no takeover path, §6).
 *   4. No identity + provider email UNVERIFIED + local user exists → REFUSE
 *      ("email_unverified") — an unverified email claim never links or
 *      takes over an existing account (§4, §6).
 *   5. No identity + provider email VERIFIED + local user exists:
 *        - anonymous → AUDITED AUTO-LINK to the existing account (one
 *          human, one account — the provider vouches for the address),
 *        - signed in  → normal link to the session user (Auth.js native).
 *   6. No identity + no local user                        → new account via
 *      the adapter (provider-verified email → ACTIVE, else PENDING).
 *
 * Suspended users are always refused. Provider emails are never merged on
 * name similarity — only exact, provider-VERIFIED addresses (§4).
 *
 * Errors do NOT render Auth.js' default HTML error page: the callback
 * returns a same-origin redirect URL into the SPA's finishing screen with
 * an explicit error code, keeping the UX consistent (§16, §30).
 */
import { db } from "@/lib/db";
import { serverEnv, type OAuthProvider } from "@/server/env";
import { getAuthContext } from "@/server/auth/auth-context";
import { recordAudit } from "@/server/audit";
import { profileEmailVerified } from "./adapter";
import { canonicalProvider } from "./provider-map";
import type { Account, Profile } from "next-auth";

/** Same-origin SPA redirect with an explicit outcome (never an HTML error page). */
export function appRedirect(params: Record<string, string>): string {
  const query = new URLSearchParams(params).toString();
  const base = serverEnv.appBaseUrl.replace(/\/$/, "");
  return `${base}/#/auth/finishing?${query}`;
}

export type OAuthIdentityProfile = {
  providerAccountId: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
  avatarUrl: string | null;
};

/** Normalize Auth.js Account+Profile into the TaskFlow identity shape. */
export function identityProfile(account: Account, profile: Profile | null): OAuthIdentityProfile {
  return {
    providerAccountId: String(account.providerAccountId ?? ""),
    email: typeof profile?.email === "string" ? profile.email.toLowerCase() : null,
    emailVerified: profileEmailVerified((profile ?? {}) as Profileish),
    name: typeof profile?.name === "string" ? profile.name : null,
    avatarUrl: typeof profile?.image === "string" ? profile.image : null,
  };
}

type Profileish = {
  emailVerified?: Date | null;
  email_verified?: boolean | string | null;
};

/**
 * The Auth.js signIn callback. Return values:
 *   true            → proceed (sign-in, link, or provisioning as decided)
 *   string (URL)    → redirect to that URL (explicit, audited refusals)
 *   false           → hard refuse (Auth.js default error page; last resort)
 */
export async function oauthSignInPolicy(account: Account, profile: Profile | null): Promise<boolean | string> {
  if (account.provider === "credentials") return true; // credentials policy lives in authorize()

  const provider = canonicalOrThrow(account.provider);
  const identity = identityProfile(account, profile);
  const ctx = getAuthContext();
  const sessionUserId = ctx.sessionUserId ?? null;

  if (!identity.providerAccountId) {
    return appRedirect({ error: "provider_error", message: "The provider did not return an account id" });
  }

  const existingIdentity = await db.authenticationIdentity.findUnique({
    where: { provider_providerAccountId: { provider, providerAccountId: identity.providerAccountId } },
    include: { user: true },
  });

  if (existingIdentity) {
    if (sessionUserId && sessionUserId !== existingIdentity.userId) {
      await recordAudit({
        action: "oauth_link_refused",
        userId: sessionUserId,
        metadata: { provider, reason: "identity_belongs_to_other_user" },
        ipAddress: ctx.ipAddress ?? null,
      });
      return appRedirect({
        error: "identity_taken",
        message: `This ${provider} account is already connected to another TaskFlow user.`,
      });
    }
    if (existingIdentity.user.status === "SUSPENDED") {
      return appRedirect({ error: "account_suspended", message: "This account is suspended" });
    }
    // Keep the stored provider email fresh (non-sensitive metadata).
    await db.authenticationIdentity.update({
      where: { id: existingIdentity.id },
      data: { providerEmail: identity.email, updatedAt: new Date() },
    }).catch(() => undefined);
    return true;
  }

  // New identity for this provider account.
  if (identity.email) {
    const userByEmail = await db.user.findUnique({ where: { email: identity.email } });

    if (userByEmail && !identity.emailVerified) {
      // An UNVERIFIED provider email claim must never link or take over an
      // existing account (§4, §6) — whether the caller is anonymous or
      // signed in as that very user (explicit connect is refused with
      // guidance; the number must prove itself via verification).
      await recordAudit({
        action: "oauth_refused_unverified_email",
        userId: sessionUserId ?? null,
        metadata: { provider, reason: "email_claim_unverified" },
        ipAddress: ctx.ipAddress ?? null,
      });
      return appRedirect({
        error: "email_unverified",
        message: `Your ${provider} account's email address is not verified. Verify it at ${provider} first, or sign in with your password and connect ${provider} from Account → Connected providers.`,
      });
    }

    if (userByEmail && identity.emailVerified && !sessionUserId) {
      // Anonymous + provider-verified email + existing local account →
      // AUDITED auto-link, then Auth.js signs the existing user in (the
      // adapter's getUserByAccount resolves the identity we create here).
      const clash = await db.authenticationIdentity.findUnique({
        where: { provider_providerAccountId: { provider, providerAccountId: identity.providerAccountId } },
      });
      if (!clash) {
        await db.authenticationIdentity.create({
          data: { userId: userByEmail.id, provider, providerAccountId: identity.providerAccountId, providerEmail: identity.email },
        });
        await upgradeEmailVerification(userByEmail.id, userByEmail.emailVerifiedAt, identity.email, identity.emailVerified);
        await recordAudit({
          action: "oauth_auto_link",
          userId: userByEmail.id,
          metadata: { provider, providerEmail: identity.email },
          ipAddress: ctx.ipAddress ?? null,
        });
      }
      return true;
    }
  }

  if (!identity.email && !sessionUserId) {
    return appRedirect({
      error: "email_required",
      message: `Your ${provider} account does not expose an email address, which TaskFlow requires.`,
    });
  }

  // Remaining cases are handled natively by Auth.js:
  //   - anonymous + no local user   → createUser (adapter applies status policy)
  //   - signed in + new identity    → linkAccount to the session user
  //   - signed in + verified email of another user → link to session user
  return true;
}

/** Provider-verified email proof upgrades (never downgrades) local verification. */
export async function upgradeEmailVerification(
  userId: string,
  currentVerifiedAt: Date | null,
  providerEmail: string | null,
  providerVerified: boolean,
): Promise<void> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { email: true, emailVerifiedAt: true } });
  if (!user) return;
  if (!providerVerified || !providerEmail || user.email !== providerEmail) return;
  if (user.emailVerifiedAt) return;
  await db.user.update({ where: { id: userId }, data: { emailVerifiedAt: new Date() } });
}

function canonicalOrThrow(authJsId: string): OAuthProvider {
  const canonical = canonicalProvider(authJsId);
  if (!canonical) throw new Error(`Unsupported OAuth provider: ${authJsId}`);
  return canonical;
}
