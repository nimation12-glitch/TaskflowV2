/**
 * Stripe configuration helper — creates REAL Stripe products/prices (test or
 * live, per the configured key) and writes the resulting Price IDs into .env.
 *
 * Usage:
 *   STRIPE_SECRET_KEY=sk_test_… bun scripts/stripe-setup.ts [--webhook-url https://…/api/webhooks/stripe]
 *   bun scripts/stripe-setup.ts                      # uses STRIPE_SECRET_KEY from .env
 *
 * Creates (idempotently, matched by product metadata taskflow.id):
 *   TaskFlow Pro    £30 / month   recurring   → STRIPE_PRICE_PRO
 *   TaskFlow Max    £90 / month   recurring   → STRIPE_PRICE_MAX
 *   TaskFlow Credits £10/£25/£50/£100 one-time → STRIPE_PRICE_CREDIT_{10,25,50,100}
 *
 * With --webhook-url it also registers a webhook endpoint for the required
 * events and prints the signing secret (whsec_…) once — store it as
 * STRIPE_WEBHOOK_SECRET.
 */
import Stripe from "stripe";
import { readFileSync, writeFileSync } from "fs";

const ENV_PATH = new URL("../.env", import.meta.url).pathname;

function envValue(name: string): string | undefined {
  if (process.env[name]) return process.env[name];
  try {
    const content = readFileSync(ENV_PATH, "utf8");
    const line = content.split("\n").find((l) => l.startsWith(`${name}=`));
    return line ? line.slice(name.length + 1).trim() : undefined;
  } catch {
    return undefined;
  }
}

function upsertEnv(entries: Record<string, string>): void {
  let content = "";
  try {
    content = readFileSync(ENV_PATH, "utf8");
  } catch {
    content = "";
  }
  for (const [key, value] of Object.entries(entries)) {
    const re = new RegExp(`^${key}=.*$`, "m");
    if (re.test(content)) {
      if (!content.match(new RegExp(`^${key}=$`, "m")) && content.match(re)![0].includes(value)) continue;
      content = content.replace(re, `${key}=${value}`);
    } else {
      content = content.trimEnd() + (content ? "\n" : "") + `${key}=${value}\n`;
    }
  }
  writeFileSync(ENV_PATH, content, "utf8");
}

async function main() {
  const args = process.argv.slice(2);
  const webhookUrlIdx = args.indexOf("--webhook-url");
  const webhookUrl = webhookUrlIdx >= 0 ? args[webhookUrlIdx + 1] : undefined;

  const secretKey = envValue("STRIPE_SECRET_KEY");
  if (!secretKey) {
    console.error("STRIPE_SECRET_KEY is not set (argument env or .env). Aborting — nothing was created.");
    process.exit(1);
  }
  const stripe = new Stripe(secretKey);
  const mode = secretKey.startsWith("sk_live_") ? "LIVE" : "TEST";
  console.log(`Connected to Stripe ${mode} mode.`);

  async function findProduct(id: string): Promise<Stripe.Product | null> {
    const list = await stripe.products.search({ query: `metadata["taskflow.id"]:"${id}"` });
    return list.data[0] ?? null;
  }

  async function ensureRecurringPrice(productSpec: {
    key: string; name: string; unitAmount: number; envVar: string; statement: string;
  }): Promise<string> {
    let product = await findProduct(productSpec.key);
    if (!product) {
      product = await stripe.products.create({
        name: productSpec.name,
        statement_descriptor: productSpec.statement,
        metadata: { "taskflow.id": productSpec.key },
      });
      console.log(`  created product: ${productSpec.name} (${product.id})`);
    }
    const prices = await stripe.prices.list({ product: product.id, active: true, limit: 10 });
    const existing = prices.data.find(
      (p) => p.recurring?.interval === "month" && p.unit_amount === productSpec.unitAmount && p.currency === "gbp",
    );
    if (existing) {
      console.log(`  price exists: ${productSpec.name} → ${existing.id}`);
      return existing.id;
    }
    const price = await stripe.prices.create({
      product: product.id,
      currency: "gbp",
      unit_amount: productSpec.unitAmount,
      recurring: { interval: "month" },
      metadata: { "taskflow.id": productSpec.key },
    });
    console.log(`  created price: ${productSpec.name} £${productSpec.unitAmount / 100}/mo → ${price.id}`);
    return price.id;
  }

  async function ensureOneTimePrice(productSpec: {
    key: string; name: string; unitAmount: number; envVar: string;
  }): Promise<string> {
    let product = await findProduct(productSpec.key);
    if (!product) {
      product = await stripe.products.create({
        name: productSpec.name,
        metadata: { "taskflow.id": productSpec.key },
      });
      console.log(`  created product: ${productSpec.name} (${product.id})`);
    }
    const prices = await stripe.prices.list({ product: product.id, active: true, limit: 10 });
    const existing = prices.data.find((p) => p.unit_amount === productSpec.unitAmount && p.currency === "gbp");
    if (existing) {
      console.log(`  price exists: ${productSpec.name} → ${existing.id}`);
      return existing.id;
    }
    const price = await stripe.prices.create({
      product: product.id,
      currency: "gbp",
      unit_amount: productSpec.unitAmount,
      metadata: { "taskflow.id": productSpec.key },
    });
    console.log(`  created price: ${productSpec.name} £${productSpec.unitAmount / 100} → ${price.id}`);
    return price.id;
  }

  const POUNDS = (n: number) => n * 100; // Stripe pence

  const proPrice = await ensureRecurringPrice({
    key: "pro", name: "TaskFlow Pro", unitAmount: POUNDS(30), envVar: "STRIPE_PRICE_PRO", statement: "TASKFLOW",
  });
  const maxPrice = await ensureRecurringPrice({
    key: "max", name: "TaskFlow Max", unitAmount: POUNDS(90), envVar: "STRIPE_PRICE_MAX", statement: "TASKFLOW",
  });
  const credit10 = await ensureOneTimePrice({ key: "credits-10", name: "TaskFlow AI credits — £10", unitAmount: POUNDS(10), envVar: "STRIPE_PRICE_CREDIT_10" });
  const credit25 = await ensureOneTimePrice({ key: "credits-25", name: "TaskFlow AI credits — £25", unitAmount: POUNDS(25), envVar: "STRIPE_PRICE_CREDIT_25" });
  const credit50 = await ensureOneTimePrice({ key: "credits-50", name: "TaskFlow AI credits — £50", unitAmount: POUNDS(50), envVar: "STRIPE_PRICE_CREDIT_50" });
  const credit100 = await ensureOneTimePrice({ key: "credits-100", name: "TaskFlow AI credits — £100", unitAmount: POUNDS(100), envVar: "STRIPE_PRICE_CREDIT_100" });

  upsertEnv({
    STRIPE_PRICE_PRO: proPrice,
    STRIPE_PRICE_MAX: maxPrice,
    STRIPE_PRICE_CREDIT_10: credit10,
    STRIPE_PRICE_CREDIT_25: credit25,
    STRIPE_PRICE_CREDIT_50: credit50,
    STRIPE_PRICE_CREDIT_100: credit100,
  });
  console.log("\nPrice IDs written to .env ✓");

  if (webhookUrl) {
    const events = [
      "checkout.session.completed",
      "invoice.paid",
      "invoice.payment_failed",
      "customer.subscription.updated",
      "customer.subscription.deleted",
    ];
    const existing = await stripe.webhookEndpoints.list({ limit: 50 });
    const match = existing.data.find((e) => e.url === webhookUrl);
    if (match) {
      console.log(`\nWebhook endpoint already exists: ${webhookUrl} (${match.id})`);
      console.log("If you need a fresh signing secret, delete/recreate it in the Stripe dashboard.");
    } else {
      const endpoint = await stripe.webhookEndpoints.create({
        url: webhookUrl,
        enabled_events: events as Stripe.WebhookEndpointCreateParams["enabled_events"],
        description: "TaskFlow billing webhooks",
      });
      console.log(`\nWebhook endpoint created: ${webhookUrl} (${endpoint.id})`);
      console.log(`Signing secret (store as STRIPE_WEBHOOK_SECRET, shown once): ${endpoint.secret}`);
    }
  }

  console.log("\nDone. Restart the dev server so the new configuration is picked up.");
}

main().catch((err) => {
  console.error("stripe-setup failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
