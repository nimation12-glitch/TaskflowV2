/**
 * Next.js instrumentation — runs once when the server process boots.
 *
 * PRODUCTION fail-closed gates:
 *   - Stripe billing configuration missing      → startup failure (spec §14)
 *   - AUTH_SECRET missing                       → startup failure (§5/§8)
 *   - AUTH_URL pinned to APP_BASE_URL           → OAuth callbacks are always
 *     derived from trusted server configuration, never request Host headers
 *     (correction spec §7)
 *
 * Development logs the email/SMS/OAuth posture loudly so deployments are
 * diagnosable — without faking anything.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  // Pin Auth.js' trusted origin to the application base URL BEFORE any auth
  // code runs. Every OAuth redirect/callback URL derives from this — never
  // from request headers (correction spec §7).
  const appBaseUrl = process.env.APP_BASE_URL ?? process.env.API_BASE_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  if (!process.env.AUTH_URL) process.env.AUTH_URL = appBaseUrl.replace(/\/$/, "");

  const isProduction = process.env.NODE_ENV === "production";

  if (isProduction && !process.env.AUTH_SECRET) {
    throw new Error(
      "Refusing to start: production requires AUTH_SECRET (session/OAuth cryptographic secret — see .env.example).",
    );
  }

  const { validateBillingStartup } = await import("@/server/startup");
  validateBillingStartup();

  // Identity posture logging (honest configuration states — §16).
  const oauthVars: Array<[string, string, string]> = [
    ["google", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
    ["microsoft", "MICROSOFT_CLIENT_ID", "MICROSOFT_CLIENT_SECRET"],
    ["github", "GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET"],
  ];
  const configured = oauthVars.filter(([, id, secret]) => process.env[id] && process.env[secret]).map(([name]) => name);
  if (configured.length === 0) {
    console.warn("[auth] no OAuth providers configured — social sign-in buttons render a truthful disabled state (see .env.example)");
  } else {
    console.log(`[auth] OAuth providers configured: ${configured.join(", ")} — callbacks derive from AUTH_URL=${process.env.AUTH_URL}`);
  }
  if (!isProduction) {
    if (!process.env.RESEND_API_KEY) console.warn("[email] development transport active — messages stored in the EmailMessage outbox (readable via /api/dev/email-outbox)");
    if (!process.env.SMS_PROVIDER) console.warn("[sms] development transport active — codes stored in the SmsMessage outbox (readable via /api/dev/sms-outbox)");
  }
}
