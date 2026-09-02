/**
 * Billing configuration validation (spec §14, §15).
 *
 * PRODUCTION (NODE_ENV=production): fail closed at startup.
 *   - missing STRIPE_SECRET_KEY        → startup/configuration failure
 *   - missing STRIPE_WEBHOOK_SECRET    → startup/configuration failure
 *   - missing any required price ID    → billing configuration failure
 *   - sk_test_ key in production       → allowed ONLY as an explicit,
 *     clearly-labelled Stripe TEST MODE deployment (staging/preview); a loud
 *     warning is logged. It is still REAL Stripe — never a simulation.
 *
 * DEVELOPMENT: Stripe TEST MODE is recommended. Without a key, billing
 * features refuse to run per-request (fail closed); the rest of the app
 * keeps working so the deployment is diagnosable rather than bricked.
 *
 * There is no simulated/fake billing path anywhere.
 */
import { serverEnv } from "@/server/env";

export class BillingConfigError extends Error {
  readonly issues: string[];
  constructor(message: string, issues: string[]) {
    super(message);
    this.name = "BillingConfigError";
    this.issues = issues;
  }
}

const PRICE_VARS: Array<[string, () => string | undefined]> = [
  ["STRIPE_PRICE_PRO", () => serverEnv.stripePricePro],
  ["STRIPE_PRICE_MAX", () => serverEnv.stripePriceMax],
  ["STRIPE_PRICE_CREDIT_10", () => serverEnv.stripePriceCredit10],
  ["STRIPE_PRICE_CREDIT_25", () => serverEnv.stripePriceCredit25],
  ["STRIPE_PRICE_CREDIT_50", () => serverEnv.stripePriceCredit50],
  ["STRIPE_PRICE_CREDIT_100", () => serverEnv.stripePriceCredit100],
];

function missingPriceVars(): string[] {
  return PRICE_VARS.filter(([, get]) => !get()).map(([name]) => name);
}

/** Human-readable list of billing configuration problems for the current mode. */
export function billingConfigIssues(): string[] {
  const issues: string[] = [];
  if (!serverEnv.stripeSecretKey) {
    issues.push("STRIPE_SECRET_KEY is not set — billing is disabled (fail closed)");
    return issues; // remaining checks are meaningless without a key
  }
  if (!serverEnv.stripeWebhookSecret) {
    issues.push("STRIPE_WEBHOOK_SECRET is not set — webhook endpoint refuses all events");
  }
  const missingPrices = missingPriceVars();
  if (missingPrices.length > 0) {
    issues.push(
      `Stripe price IDs not configured: ${missingPrices.join(", ")} — affected checkouts are refused`,
    );
  }
  return issues;
}

/**
 * Production startup gate. Throws BillingConfigError when the deployment
 * cannot operate billing safely. Called from instrumentation register()
 * (server boot) and available for handlers as defence in depth.
 */
export function validateBillingStartup(): void {
  const issues = billingConfigIssues();

  if (serverEnv.isProduction) {
    if (!serverEnv.stripeSecretKey) {
      throw new BillingConfigError(
        "Refusing to start: production requires STRIPE_SECRET_KEY (real Stripe billing; simulated billing is not supported).",
        issues,
      );
    }
    if (!serverEnv.stripeWebhookSecret) {
      throw new BillingConfigError(
        "Refusing to start: production requires STRIPE_WEBHOOK_SECRET (unverified webhooks are never applied).",
        issues,
      );
    }
    if (missingPriceVars().length > 0) {
      throw new BillingConfigError(
        `Refusing to start: production requires all Stripe price IDs (${missingPriceVars().join(", ")}).`,
        issues,
      );
    }
    if (serverEnv.stripeMode === "test") {
      console.warn(
        "╔══════════════════════════════════════════════════════════════════╗\n" +
          "║  STRIPE TEST MODE in a production build — this deployment uses   ║\n" +
          "║  sk_test_ credentials. Payments run against Stripe test data.    ║\n" +
          "║  Swap to sk_live_ + live prices before serving real customers.   ║\n" +
          "╚══════════════════════════════════════════════════════════════════╝",
      );
    }
    console.log("[billing] production Stripe configuration validated (mode: live)");
    return;
  }

  // Development / test: log posture, never fake anything.
  if (!serverEnv.stripeSecretKey) {
    console.warn("[billing] development without STRIPE_SECRET_KEY — billing endpoints fail closed (503)");
  } else {
    console.log(`[billing] development Stripe ${serverEnv.stripeMode?.toUpperCase()} MODE`);
    if (!serverEnv.stripeWebhookSecret) {
      console.warn(
        "[billing] STRIPE_WEBHOOK_SECRET not set — webhooks refused; checkout verification-on-return still applies verified payments (use `bun run stripe:setup`)",
      );
    }
  }
}

