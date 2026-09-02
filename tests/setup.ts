/**
 * Bun test preload — runs BEFORE any test file (and therefore before any
 * PrismaClient is constructed). Points Prisma at an ISOLATED test database
 * and configures offline Stripe TEST credentials for signature verification.
 *
 * NOTE: no `import` of app modules here — ESM imports would hoist above the
 * env assignments below and initialise the client against the wrong DB.
 */
import { execSync } from "child_process";
import { rmSync } from "fs";

const TEST_DB = "file:/home/z/my-project/db/test-billing.db";

// Isolated database for the billing suite (never the dev database).
process.env.DATABASE_URL = TEST_DB;
process.env.TASKFLOW_API_KEY_PEPPER = process.env.TASKFLOW_API_KEY_PEPPER ?? "test-pepper-NOT-FOR-PRODUCTION";
// Offline Stripe TEST credentials — constructEvent works without network.
process.env.STRIPE_SECRET_KEY = "sk_test_unit_test_key";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_test_signing_secret";
// Hermetic deployment config: tests construct requests at localhost:3000,
// so the canonical base URL MUST match regardless of the developer's
// ambient .env (e.g. a sandbox .env pointing APP_BASE_URL at the preview
// front would otherwise make Auth.js fold policy redirects back to the
// bare request origin — tests assert the rich policy redirect shape).
process.env.APP_BASE_URL = "http://localhost:3000";
process.env.TRUSTED_ORIGINS = "http://localhost:3000";
// Tests exercise non-production configuration validation by default.
(process.env as { NODE_ENV?: string }).NODE_ENV = "test";

const dbPath = TEST_DB.replace("file:", "");
rmSync(dbPath, { force: true });

// Push the current schema into the isolated DB.
execSync("bunx prisma db push --skip-generate --accept-data-loss", {
  env: process.env,
  cwd: "/home/z/my-project",
  stdio: "pipe",
});

console.log(`[tests] isolated billing database ready: ${dbPath}`);
