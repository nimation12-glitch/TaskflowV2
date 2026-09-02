/**
 * Auth.js (next-auth v5) — the TaskFlow authentication framework
 * (correction spec §1, §5, §8, §16).
 *
 * ARCHITECTURE
 *   - OAuth protocol (Google / Microsoft Entra ID / GitHub): fully owned by
 *     Auth.js — state, PKCE, nonce, code exchange, ID-token validation.
 *     Mounted at /api/auth/[...nextauth] (basePath /api/auth).
 *   - Sessions: DATABASE strategy through the custom TaskFlow adapter —
 *     the existing Session table with sha256-hashed tokens, revocation,
 *     lastUsedAt, IP/UA (§8). One cookie (`tf_session`) shared by every
 *     TaskFlow route via server/auth/session.ts.
 *   - Credentials (email/password): an Auth.js Credentials provider whose
 *     authorize() holds the verification policy. Auth.js' credentials flow
 *     is JWT-only by design (documented limitation) while TaskFlow requires
 *     database sessions (§8) — so /api/auth/login drives the SAME provider
 *     through the framework's Auth() entry (raw + skipCSRFCheck, exactly
 *     like next-auth's own server actions) and converts the result into a
 *     TaskFlow DB session. No second session mechanism, no JWT cookies.
 *
 * ORIGIN TRUST (§7): callbacks are derived from AUTH_URL — startup pins
 * AUTH_URL to APP_BASE_URL, so request Host headers are never trusted.
 *
 * SECRETS (§14): only client IDs are public; secrets/AUTH_SECRET live
 * server-side and are never exposed to browser code.
 */
import NextAuth from "next-auth";
import GoogleProvider from "next-auth/providers/google";
import GitHubProvider from "next-auth/providers/github";
import MicrosoftEntraIDProvider from "next-auth/providers/microsoft-entra-id";
import CredentialsProvider from "next-auth/providers/credentials";
import type { Provider } from "next-auth/providers";
import { serverEnv } from "@/server/env";
import { taskflowAdapter, profileEmailVerified, generateSessionToken } from "./adapter";
import { oauthSignInPolicy, identityProfile, upgradeEmailVerification, appRedirect } from "./policy";
import { canonicalProvider } from "./provider-map";
import { db } from "@/lib/db";
import { recordAudit } from "@/server/audit";
import { activateUserIfEligible, ensureUserProvisioned } from "@/server/tenancy/activation";
import { verifyPassword } from "@/server/auth/password";
import { getAuthContext, updateAuthContext } from "@/server/auth/auth-context";

// ── Providers ────────────────────────────────────────────────────────────

function buildProviders(): Provider[] {
  const providers: Provider[] = [];

  // Credentials — the verification policy for email/password sign-in.
  // (HTTP entry point: POST /api/auth/login → Auth.js callback/credentials.)
  providers.push(
    CredentialsProvider({
      id: "credentials",
      name: "Email & Password",
      credentials: {
        email: { label: "Email", type: "text" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        const ctx = getAuthContext();
        const ip = ctx.ipAddress ?? "unknown";
        const email = String(credentials?.email ?? "").trim().toLowerCase();
        const password = String(credentials?.password ?? "");
        if (!email || !password) return null;

        const user = await db.user.findUnique({
          where: { email },
          include: { passwordCredential: true },
        });
        const passwordOk = user?.passwordCredential
          ? verifyPassword(password, user.passwordCredential.passwordHash)
          : false;

        // Uniform failure — no account enumeration (§33 old spec). Suspended
        // accounts are indistinguishable from bad credentials.
        if (!user || user.status === "SUSPENDED" || !passwordOk) {
          await recordAudit({
            action: "login_failed",
            userId: user && user.status === "ACTIVE" ? user.id : null,
            metadata: { reason: user?.status === "ACTIVE" ? "bad_credentials" : user ? "suspended" : "unknown_email", via: "authjs_credentials" },
            ipAddress: ip,
          });
          return null;
        }

        await db.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
        await recordAudit({ action: "login", userId: user.id, ipAddress: ip });
        updateAuthContext({ credentialsResult: { userId: user.id } });
        return { id: user.id, email: user.email, name: user.name };
      },
    }),
  );
  if (serverEnv.googleClientId && serverEnv.googleClientSecret) {
    providers.push(
      GoogleProvider({
        clientId: serverEnv.googleClientId,
        clientSecret: serverEnv.googleClientSecret,
        authorization: { params: { scope: "openid email profile" } },
        // STATE + NONCE + PKCE are ALL mandatory (correction spec §5/§10):
        // this core version defaults to PKCE-only for this provider.
        checks: ["pkce", "state", "nonce"],
        profile(p) {
          return {
            id: String(p.sub ?? p.id ?? ""),
            name: typeof p.name === "string" ? p.name : null,
            email: typeof p.email === "string" ? p.email : null,
            image: typeof p.picture === "string" ? p.picture : null,
            email_verified: p.email_verified === true,
          };
        },
      }),
    );
  }

  if (serverEnv.microsoftClientId && serverEnv.microsoftClientSecret) {
    providers.push(
      MicrosoftEntraIDProvider({
        clientId: serverEnv.microsoftClientId,
        clientSecret: serverEnv.microsoftClientSecret,
        // MICROSOFT_TENANT_ID pins the directory (§5/§11): the issuer AND the
        // discovery document derive from it, not from request parameters.
        issuer: `https://login.microsoftonline.com/${serverEnv.microsoftTenantId}/v2.0`,
        // Identity-only scope — the Entra default includes Graph "User.Read";
        // it is deliberately removed (no Graph resources, Phase 1 §14).
        authorization: { params: { scope: "openid profile email" } },
        // State + nonce + PKCE all mandatory (correction spec §5/§10).
        checks: ["pkce", "state", "nonce"],
        // Custom profile replaces the default Graph photo fetch (keeps the
        // flow within the identity-only scope).
        profile(p) {
          const claimEmail = typeof p.email === "string" && p.email ? p.email : null;
          const upn = typeof p.preferred_username === "string" && p.preferred_username.includes("@") ? p.preferred_username : null;
          // Entra directory addresses are issuer-vouched ⇒ verified.
          const email = claimEmail ?? upn;
          return {
            id: String(p.sub ?? p.oid ?? ""),
            name: typeof p.name === "string" ? p.name : null,
            email,
            image: null,
            email_verified: Boolean(email),
          };
        },
      }),
    );
  }

  if (serverEnv.githubClientId && serverEnv.githubClientSecret) {
    providers.push(
      GitHubProvider({
        clientId: serverEnv.githubClientId,
        clientSecret: serverEnv.githubClientSecret,
        // GitHub is plain OAuth2 (no ID token → no nonce); state + PKCE
        // enforced (correction spec §5/§10).
        checks: ["pkce", "state"],
        // The official provider resolves the private primary email via
        // /user/emails; this request() also carries the VERIFIED flag so the
        // linking policy can rely on it.
        userinfo: {
          url: "https://api.github.com/user",
          async request({ tokens }) {
            const headers = { Authorization: `Bearer ${tokens.access_token}`, "User-Agent": "TaskFlow" };
            const res = await fetch("https://api.github.com/user", { headers });
            if (!res.ok) throw new Error("Could not read the GitHub profile");
            const profile = (await res.json()) as Record<string, unknown>;
            if (!profile.email) {
              const emailsRes = await fetch("https://api.github.com/user/emails", { headers });
              if (emailsRes.ok) {
                const emails = (await emailsRes.json()) as Array<{ email: string; primary: boolean; verified: boolean }>;
                const primary = emails.find((e) => e.primary) ?? emails[0];
                if (primary) {
                  profile.email = primary.email;
                  profile.email_verified = primary.verified;
                }
              }
            } else {
              // A public email from /user — GitHub has already verified it
              // to be deliverable; treat verification conservatively as
              // false unless the emails endpoint confirms (handled below).
              const emailsRes = await fetch("https://api.github.com/user/emails", { headers });
              if (emailsRes.ok) {
                const emails = (await emailsRes.json()) as Array<{ email: string; primary: boolean; verified: boolean }>;
                const match = emails.find((e) => e.email === profile.email);
                profile.email_verified = Boolean(match?.verified);
              }
            }
            return profile;
          },
        },
        profile(p) {
          return {
            id: String(p.id ?? ""),
            name: (p.name as string | null) ?? (p.login as string | null),
            email: typeof p.email === "string" ? p.email : null,
            image: typeof p.avatar_url === "string" ? p.avatar_url : null,
            email_verified: p.email_verified === true,
          };
        },
      }),
    );
  }

  return providers;
}

// ── NextAuth configuration ───────────────────────────────────────────────

export const authConfig = {
  adapter: taskflowAdapter,
  providers: buildProviders(),
  // Never pass an empty secret — core must fail loudly (MissingSecret) and
  // the startup gate already refuses production boots without AUTH_SECRET.
  secret: serverEnv.authSecret || undefined,
  trustHost: true,
  basePath: "/api/auth",
  // Behind the Caddy gateway the internal request URL is http; cookie
  // security is pinned to the DEPLOYMENT mode, not the internal protocol.
  useSecureCookies: serverEnv.isProduction,
  session: {
    strategy: "database" as const,
    maxAge: 30 * 24 * 60 * 60, // 30 days — matches server/auth/session.ts
    generateSessionToken,
  },
  cookies: {
    // ONE session cookie for the whole application (§8) — TaskFlow's own
    // helpers (server/auth/session.ts) read the same name.
    sessionToken: {
      name: "tf_session",
      options: {
        httpOnly: true,
        sameSite: "lax" as const,
        path: "/",
        secure: serverEnv.isProduction,
      },
    },
  },
  pages: {
    // Auth.js error fallbacks land in the SPA (hash-routed), never an HTML
    // error page (§16/§30). Handled refusals redirect to the same screen
    // with explicit error codes (see policy.ts appRedirect()).
    error: "/#/auth/finishing",
    signIn: "/#/auth/signin",
  },
  callbacks: {
    async signIn(params) {
      if (params.account?.provider === "credentials") return true;
      if (!params.account) return false;
      return oauthSignInPolicy(params.account, params.profile ?? null);
    },
    async session({ session, user }) {
      if (session.user && user) {
        session.user.id = user.id;
      }
      return session;
    },
  },
  events: {
    /**
     * Runs after EVERY successful sign-in: refresh login metadata, audit,
     * upgrade email verification from provider proof, guarantee provisioning
     * (idempotent — repeated OAuth callbacks can never duplicate the
     * organization, §9/§32) and apply the activation policy.
     */
    async signIn(message) {
      const { user, account, profile, isNewUser } = message as {
        user?: { id?: string; email?: string | null };
        account?: { provider?: string; type?: string } | null;
        profile?: Record<string, unknown> | null;
        isNewUser?: boolean;
      };
      const userId = user?.id;
      const accountProvider = account?.provider;
      if (!accountProvider || accountProvider === "credentials" || !userId) return;
      const provider = canonicalProvider(accountProvider);
      if (!provider) return;

      const ctx = getAuthContext();
      await db.user.update({ where: { id: userId }, data: { lastLoginAt: new Date() } }).catch(() => undefined);

      if (isNewUser) {
        await recordAudit({
          action: "signup",
          userId,
          metadata: { provider },
          ipAddress: ctx.ipAddress ?? null,
        });
      }
      await recordAudit({
        action: "oauth_signin",
        userId,
        metadata: { provider, newUser: Boolean(isNewUser) },
        ipAddress: ctx.ipAddress ?? null,
      });

      // Provider-verified email proof upgrades local verification (never
      // downgrades) when the addresses match (§6).
      if (profile && accountProvider !== "credentials") {
        const identity = identityProfile(account as never, profile as never);
        const current = await db.user.findUnique({ where: { id: userId }, select: { email: true, emailVerifiedAt: true } });
        if (current) {
          await upgradeEmailVerification(userId, current.emailVerifiedAt, identity.email, identity.emailVerified);
        }
      }

      await activateUserIfEligible(userId, { ip: ctx.ipAddress ?? null, trigger: "oauth_signin" });
      await ensureUserProvisioned(userId, { ip: ctx.ipAddress ?? null });
    },
  },
  logger: {
    // Never log tokens/credentials — Auth.js debug logging stays off.
    error(error) {
      const cause = (error as { cause?: { err?: Error } })?.cause;
      console.error(`[authjs] ${error instanceof Error ? error.message : String(error)}`, cause ? `cause: ${cause.err?.message ?? cause}` : "");
    },
    warn(code) {
      console.warn(`[authjs] warning: ${typeof code === "string" ? code : code instanceof Error ? code.message : ""}`);
    },
  },
};

export const { handlers, auth, signIn, signOut } = NextAuth(authConfig);

// Re-exports used by the login route and the catch-all wrapper.
export { profileEmailVerified, appRedirect };
