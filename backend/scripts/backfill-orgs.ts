/**
 * One-off backfill: anchor billing on Organizations.
 *
 * 1. Creates a personal Organization for every user that lacks one
 *    (the tenancy phase will introduce multi-member orgs; billing needs
 *    the Organization entity to exist NOW).
 * 2. Re-points Subscription / CreditAccount / Invoice / CreditTransaction
 *    to the owning organization (organizationId = org of the row's user).
 * 3. Migrates legacy StripeCustomer rows onto Organization.stripeCustomerId.
 *
 * Idempotent: safe to run repeatedly.
 * Run: bun scripts/backfill-orgs.ts
 */
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "org";
}

async function ensurePersonalOrg(userId: string, email: string, name: string | null) {
  const existing = await db.organization.findFirst({ where: { ownerUserId: userId } });
  if (existing) return existing;

  const base = slugify(name ?? email.split("@")[0]);
  // Slug collision-safe: append short id fragment until unique.
  for (let attempt = 0; attempt < 5; attempt++) {
    const suffix = Math.random().toString(36).slice(2, 7);
    const slug = attempt === 0 ? base : `${base}-${suffix}`;
    try {
      return await db.organization.create({
        data: {
          name: name ? `${name}'s Organization` : `Organization for ${email}`,
          slug,
          ownerUserId: userId,
        },
      });
    } catch {
      // slug collision → retry with a fresh suffix
    }
  }
  throw new Error(`Could not create organization for user ${userId}`);
}

async function main() {
  const users = await db.user.findMany({
    select: { id: true, email: true, name: true },
  });
  console.log(`Backfilling organizations for ${users.length} users…`);

  const orgByUser = new Map<string, { id: string; stripeCustomerId: string | null }>();
  for (const u of users) {
    const org = await ensurePersonalOrg(u.id, u.email, u.name);
    orgByUser.set(u.id, { id: org.id, stripeCustomerId: org.stripeCustomerId });
  }

  // 2. Legacy StripeCustomer → Organization.stripeCustomerId
  let legacyCustomers: Array<{ userId: string; stripeCustomerId: string }> = [];
  try {
    // The StripeCustomer table is dropped by the schema migration; read it
    // only if it still exists (idempotency across migration stages).
    legacyCustomers = await (db as any).stripeCustomer.findMany();
  } catch {
    /* table already migrated away */
  }
  for (const row of legacyCustomers) {
    const org = orgByUser.get(row.userId);
    if (!org || org.stripeCustomerId) continue;
    await db.organization.update({
      where: { id: org.id },
      data: { stripeCustomerId: row.stripeCustomerId },
    });
    org.stripeCustomerId = row.stripeCustomerId;
    console.log(`  migrated StripeCustomer ${row.stripeCustomerId} → org`);
  }

  // 3. Re-point owned rows.
  const subs = (await db.subscription.findMany()).filter((s) => !s.organizationId);
  for (const s of subs) {
    const org = orgByUser.get(s.userId);
    if (!org) continue;
    await db.subscription.update({
      where: { id: s.id },
      data: {
        organizationId: org.id,
        // Backfill the Stripe customer onto the subscription for reconciliation.
        stripeCustomerId: s.stripeCustomerId ?? org.stripeCustomerId,
      },
    });
  }
  console.log(`  subscriptions re-pointed: ${subs.length}`);

  const accounts = await db.creditAccount.findMany({ where: { organizationId: null } });
  for (const a of accounts) {
    const org = orgByUser.get(a.userId);
    if (!org) continue;
    await db.creditAccount.update({ where: { id: a.id }, data: { organizationId: org.id } });
  }
  console.log(`  credit accounts re-pointed: ${accounts.length}`);

  const invoices = await db.invoice.findMany({ where: { organizationId: null } });
  for (const i of invoices) {
    const org = orgByUser.get(i.userId);
    if (!org) continue;
    await db.invoice.update({ where: { id: i.id }, data: { organizationId: org.id } });
  }
  console.log(`  invoices re-pointed: ${invoices.length}`);

  const txs = await db.creditTransaction.findMany({ where: { organizationId: null } });
  for (const t of txs) {
    const org = orgByUser.get(t.userId);
    if (!org) continue;
    await db.creditTransaction.update({ where: { id: t.id }, data: { organizationId: org.id } });
  }
  console.log(`  ledger rows re-pointed: ${txs.length}`);

  console.log("Backfill complete.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
