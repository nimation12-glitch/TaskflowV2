/**
 * Auth.js provider registry (correction spec §1, §5, §7).
 *
 * The OAuth PROTOCOL is owned by Auth.js (next-auth v5 — the current
 * NextAuth architecture): state, PKCE, nonce, authorization-URL construction
 * and code exchange are all handled by the framework. Providers are the
 * official built-ins (Google / Microsoft Entra ID / GitHub) configured with
 * IDENTITY-ONLY scopes:
 *   Google    → openid email profile      (no Drive/Gmail — §13 old spec)
 *   Microsoft → openid profile email      (no Graph resources; the Entra
 *              default "User.Read" scope is deliberately REMOVED and the
 *              default Graph photo fetch is replaced)
 *   GitHub    → read:user user:email      (no repo scopes)
 *
 * Callback URLs are derived ONLY from trusted server configuration:
 *   {APP_BASE_URL}/api/auth/callback/{provider}
 * (Auth.js builds them from AUTH_URL, which startup pins to APP_BASE_URL —
 * request Host headers are never trusted, correction spec §7.)
 *
 * A provider without BOTH client id and secret is DISABLED: sign-in refuses
 * with a clear configuration error and the UI shows a disabled state —
 * authentication is never faked (§4, §16, §46).
 */
import { serverEnv, type OAuthProvider } from "@/server/env";

export const OAUTH_PROVIDERS: OAuthProvider[] = ["google", "microsoft", "github"];

export function isOAuthProvider(value: string): value is OAuthProvider {
  return (OAUTH_PROVIDERS as string[]).includes(value);
}

/**
 * Map a canonical TaskFlow provider name to the Auth.js provider id.
 * "microsoft" is exposed to users/config as MICROSOFT_* while the official
 * Auth.js Entra ID provider id is "microsoft-entra-id".
 */
export function authJsProviderId(provider: OAuthProvider): string {
  return provider === "microsoft" ? "microsoft-entra-id" : provider;
}

/** Map an Auth.js provider id (from an Account row) to the canonical name. */
export function canonicalProvider(authJsId: string): OAuthProvider | null {
  if (authJsId === "google") return "google";
  if (authJsId === "github") return "github";
  if (authJsId === "microsoft-entra-id" || authJsId === "azure-ad") return "microsoft";
  return null;
}

/** The EXACT callback URL to register in each provider console (§7). */
export function providerCallbackUrl(provider: OAuthProvider): string {
  const base = serverEnv.appBaseUrl.replace(/\/$/, "");
  return `${base}/api/auth/callback/${authJsProviderId(provider)}`;
}

export function isProviderConfigured(provider: OAuthProvider): boolean {
  switch (provider) {
    case "google":
      return Boolean(serverEnv.googleClientId && serverEnv.googleClientSecret);
    case "microsoft":
      return Boolean(serverEnv.microsoftClientId && serverEnv.microsoftClientSecret);
    case "github":
      return Boolean(serverEnv.githubClientId && serverEnv.githubClientSecret);
  }
}
