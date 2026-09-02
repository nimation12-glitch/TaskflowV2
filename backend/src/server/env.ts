/**
 * Server-side environment access & capability flags.
 * Centralised so handlers never read process.env ad hoc.
 *
 * BILLING CONFIGURATION (spec §2, §14, §15):
 *   STRIPE_SECRET_KEY         sk_live_… (production) | sk_test_… (development)
 *   STRIPE_WEBHOOK_SECRET     whsec_… from the Stripe dashboard/CLI
 *   STRIPE_PRICE_PRO          recurring price for Pro £30/month
 *   STRIPE_PRICE_MAX          recurring price for Max £90/month
 *   STRIPE_PRICE_CREDIT_10    one-time price £10 credit pack
 *   STRIPE_PRICE_CREDIT_25    one-time price £25 credit pack
 *   STRIPE_PRICE_CREDIT_50    one-time price £50 credit pack
 *   STRIPE_PRICE_CREDIT_100   one-time price £100 credit pack
 *   API_BASE_URL              public base URL used for Checkout redirects
 *
 * There is NO simulated-billing mode. When Stripe is not configured the
 * billing features refuse to run (fail closed) — see src/server/startup.ts.
 */

export type StripeMode = "live" | "test" | null;
export type OAuthProvider = "google" | "microsoft" | "github";

function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim().length > 0 ? v.trim() : undefined;
}

export const serverEnv = {
  get pepper(): string {
    return process.env.TASKFLOW_API_KEY_PEPPER ?? "taskflow-dev-pepper-NOT-FOR-PRODUCTION";
  },
  get apiKeyPepperConfigured(): boolean {
    return Boolean(process.env.TASKFLOW_API_KEY_PEPPER);
  },

  // ── Core application secret (Phase 1 §11) ────────────────
  // Signs Auth.js state/PKCE artifacts and other in-process security
  // artifacts. REQUIRED in production (startup fails closed — startup.ts).
  // An EMPTY value is treated as unset (a common .env footgun).
  get authSecret(): string {
    const raw = process.env.AUTH_SECRET?.trim();
    if (raw) return raw;
    return this.isProduction ? "" : "taskflow-dev-auth-secret-NOT-FOR-PRODUCTION";
  },
  get authSecretConfigured(): boolean {
    return Boolean(process.env.AUTH_SECRET);
  },

  // ── OAuth providers (Phase 1 §11–§15) ────────────────────
  // Identity-only, minimal scopes. A provider without BOTH id and secret is
  // DISABLED — the UI shows a configuration state and the endpoints refuse;
  // authentication is never faked (§4/§46).
  get googleClientId(): string | undefined {
    return env("GOOGLE_CLIENT_ID");
  },
  get googleClientSecret(): string | undefined {
    return env("GOOGLE_CLIENT_SECRET");
  },
  get microsoftClientId(): string | undefined {
    return env("MICROSOFT_CLIENT_ID");
  },
  get microsoftClientSecret(): string | undefined {
    return env("MICROSOFT_CLIENT_SECRET");
  },
  get microsoftTenantId(): string {
    return env("MICROSOFT_TENANT_ID") ?? "common";
  },
  get githubClientId(): string | undefined {
    return env("GITHUB_CLIENT_ID");
  },
  get githubClientSecret(): string | undefined {
    return env("GITHUB_CLIENT_SECRET");
  },

  // ── Transactional email (Phase 1 §35) ────────────────────
  // Development: unset → console + DB outbox transport.
  // Production:  RESEND_API_KEY expected; unconfigured → emails refuse to
  // send with a loud warning (verification/reset/invitations need a provider).
  get resendApiKey(): string | undefined {
    return env("RESEND_API_KEY");
  },
  get emailFrom(): string {
    return env("EMAIL_FROM") ?? "TaskFlow <noreply@taskflow.web-agent.org>";
  },
  get emailTransport(): "resend" | "dev-console" {
    return this.resendApiKey ? "resend" : "dev-console";
  },

  // ── SMS / phone verification (correction spec §3, §13) ───
  // Pluggable provider — business logic only ever sees the SmsProvider
  // interface. Selection is environment-driven, NEVER hardcoded:
  //   SMS_PROVIDER=dev      console + SmsMessage outbox (development/test)
  //   SMS_PROVIDER=twilio   Twilio REST API (production provider)
  // unset                  dev in non-production; production = fail closed
  //                        (phone verification cannot complete → explicit
  //                        "sms_not_configured" state, never a fake send).
  get smsProvider(): "dev" | "twilio" | undefined {
    const raw = env("SMS_PROVIDER")?.toLowerCase();
    return raw === "twilio" || raw === "dev" ? raw : undefined;
  },
  get twilioAccountSid(): string | undefined {
    return env("TWILIO_ACCOUNT_SID");
  },
  get twilioAuthToken(): string | undefined {
    return env("TWILIO_AUTH_TOKEN");
  },
  get twilioFromNumber(): string | undefined {
    return env("TWILIO_FROM_NUMBER");
  },
  get twilioMessagingServiceSid(): string | undefined {
    return env("TWILIO_MESSAGING_SERVICE_SID");
  },
  get smsTransport(): "twilio" | "dev" | "unconfigured" {
    const declared = this.smsProvider;
    if (declared === "twilio") {
      const credsOk = Boolean(this.twilioAccountSid && this.twilioAuthToken && (this.twilioFromNumber || this.twilioMessagingServiceSid));
      return credsOk ? "twilio" : "unconfigured";
    }
    if (declared === "dev") return "dev";
    return this.isProduction ? "unconfigured" : "dev";
  },

  // ── Stripe ───────────────────────────────────────────────
  get stripeSecretKey(): string | undefined {
    return env("STRIPE_SECRET_KEY");
  },
  get stripeWebhookSecret(): string | undefined {
    return env("STRIPE_WEBHOOK_SECRET");
  },
  get stripePricePro(): string | undefined {
    return env("STRIPE_PRICE_PRO");
  },
  get stripePriceMax(): string | undefined {
    return env("STRIPE_PRICE_MAX");
  },
  get stripePriceCredit10(): string | undefined {
    return env("STRIPE_PRICE_CREDIT_10");
  },
  get stripePriceCredit25(): string | undefined {
    return env("STRIPE_PRICE_CREDIT_25");
  },
  get stripePriceCredit50(): string | undefined {
    return env("STRIPE_PRICE_CREDIT_50");
  },
  get stripePriceCredit100(): string | undefined {
    return env("STRIPE_PRICE_CREDIT_100");
  },
  /** Stripe API mode implied by the configured secret key (sk_test_/sk_live_). */
  get stripeMode(): StripeMode {
    const key = this.stripeSecretKey;
    if (!key) return null;
    return key.startsWith("sk_live_") ? "live" : "test";
  },
  get isProduction(): boolean {
    return process.env.NODE_ENV === "production";
  },

  get appBaseUrl(): string {
    return env("APP_BASE_URL") ?? env("API_BASE_URL") ?? process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  },

  // ── Split deployments (frontend/backend) ───────────────────────────────
  // FRONTEND_BASE_URL names where the SPA is hosted (e.g. Vercel). Every
  // user-facing redirect and emailed link targets it: OAuth finishing,
  // email verification, password reset, invitations, checkout returns.
  // Unset → same-origin deployment (this app serves both UI and API).
  get frontendBaseUrl(): string {
    return env("FRONTEND_BASE_URL") ?? this.appBaseUrl;
  },
  get isSplitDeployment(): boolean {
    return Boolean(env("FRONTEND_BASE_URL"));
  },

  // ── Deployment environments (multi-origin trust) ─────────
  // One codebase, several legitimate fronts:
  //   development:  http://localhost:3000 (direct) AND the sandbox preview
  //                 URL (https://preview-chat-….space-z.ai)
  //   production:   https://taskflow.web-agent.org (Vercel-hosted frontend)
  // APP_BASE_URL names the CANONICAL origin of THIS deployment — OAuth
  // callbacks, Stripe redirects and email links derive from it, never from
  // request Host headers (§7). TRUSTED_ORIGINS (comma-separated) whitelists
  // the additional origins legitimate users may reach the deployment
  // through; ONLY these are accepted by the same-origin CSRF check —
  // arbitrary hosts are never trusted.
  get trustedOrigins(): string[] {
    const list: string[] = [];
    const push = (raw: string | undefined) => {
      if (!raw) return;
      for (const part of raw.split(",")) {
        const candidate = part.trim().replace(/\/+$/, "");
        if (candidate) list.push(candidate);
      }
    };
    push(process.env.APP_BASE_URL);
    push(process.env.TRUSTED_ORIGINS);
    return Array.from(new Set(list));
  },
};

/** Provider credential registry — adapters only registered when configured. */
export function providerCredentials(): Record<string, string | undefined> {
  return {
    moonshot: process.env.MOONSHOT_API_KEY,
    openrouter: process.env.OPENROUTER_API_KEY,
    openai: process.env.OPENAI_API_KEY,
    nvidia: process.env.NVIDIA_API_KEY,
  };
}
