/// <reference types="bun-types" />
/**
 * Billing configuration validation (spec §14, §15, §19 items 15–16):
 *  15. production + missing Stripe configuration → refuses (throws)
 *  16. development / test-mode configuration → accepted
 */
import { describe, test, expect } from "bun:test";
import { validateBillingStartup, billingConfigIssues, BillingConfigError } from "@/server/startup";

function withEnv(values: Record<string, string | undefined>, fn: () => void): void {
  const keys = Object.keys(values);
  const saved = keys.map((k) => [k, process.env[k]] as const);
  try {
    for (const [k, v] of Object.entries(values)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const FULL_PRODUCTION = {
  NODE_ENV: "production",
  STRIPE_SECRET_KEY: "sk_live_unit_test",
  STRIPE_WEBHOOK_SECRET: "whsec_unit_test",
  STRIPE_PRICE_PRO: "price_pro",
  STRIPE_PRICE_MAX: "price_max",
  STRIPE_PRICE_CREDIT_10: "price_c10",
  STRIPE_PRICE_CREDIT_25: "price_c25",
  STRIPE_PRICE_CREDIT_50: "price_c50",
  STRIPE_PRICE_CREDIT_100: "price_c100",
};

describe("production startup validation (fail closed)", () => {
  test("15a. production + missing STRIPE_SECRET_KEY → startup failure", () => {
    withEnv(
      { NODE_ENV: "production", STRIPE_SECRET_KEY: undefined },
      () => {
        expect(() => validateBillingStartup()).toThrow(BillingConfigError);
        expect(() => validateBillingStartup()).toThrow(/STRIPE_SECRET_KEY/);
      },
    );
  });

  test("15b. production + missing STRIPE_WEBHOOK_SECRET → startup failure", () => {
    withEnv(
      { ...FULL_PRODUCTION, STRIPE_WEBHOOK_SECRET: undefined },
      () => {
        expect(() => validateBillingStartup()).toThrow(/STRIPE_WEBHOOK_SECRET/);
      },
    );
  });

  test("15c. production + missing price IDs → billing configuration failure", () => {
    withEnv(
      { ...FULL_PRODUCTION, STRIPE_PRICE_PRO: undefined, STRIPE_PRICE_CREDIT_50: undefined },
      () => {
        expect(() => validateBillingStartup()).toThrow(/STRIPE_PRICE_PRO, STRIPE_PRICE_CREDIT_50/);
      },
    );
  });

  test("15d. production + full configuration → starts (test key warns, does not brick)", () => {
    withEnv(FULL_PRODUCTION, () => {
      expect(() => validateBillingStartup()).not.toThrow();
      expect(billingConfigIssues()).toEqual([]);
    });
  });
});

describe("development / test-mode configuration", () => {
  test("16a. development without Stripe → no startup failure, issues reported, billing fails closed per request", () => {
    withEnv(
      { NODE_ENV: "development", STRIPE_SECRET_KEY: undefined },
      () => {
        expect(() => validateBillingStartup()).not.toThrow();
        const issues = billingConfigIssues();
        expect(issues[0]).toContain("STRIPE_SECRET_KEY is not set");
        expect(issues[0]).toContain("fail closed");
      },
    );
  });

  test("16b. development with TEST MODE key + webhook secret → valid", () => {
    withEnv(
      {
        NODE_ENV: "development",
        STRIPE_SECRET_KEY: "sk_test_unit",
        STRIPE_WEBHOOK_SECRET: "whsec_unit",
        STRIPE_PRICE_PRO: "price_pro",
        STRIPE_PRICE_MAX: "price_max",
        STRIPE_PRICE_CREDIT_10: "price_c10",
        STRIPE_PRICE_CREDIT_25: "price_c25",
        STRIPE_PRICE_CREDIT_50: "price_c50",
        STRIPE_PRICE_CREDIT_100: "price_c100",
      },
      () => {
        expect(() => validateBillingStartup()).not.toThrow();
        expect(billingConfigIssues()).toEqual([]);
      },
    );
  });

  test("16c. development with TEST MODE key but no webhook secret → explicit issue listed", () => {
    withEnv(
      { NODE_ENV: "development", STRIPE_SECRET_KEY: "sk_test_unit", STRIPE_WEBHOOK_SECRET: undefined },
      () => {
        const issues = billingConfigIssues();
        expect(issues.some((i) => i.includes("STRIPE_WEBHOOK_SECRET"))).toBe(true);
      },
    );
  });
});
