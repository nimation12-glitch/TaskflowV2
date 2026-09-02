/**
 * Phase 1 data migration — multi-tenancy backfill (spec STEP 4).
 *
 * Runs AFTER the schema expansion push. Idempotent (safe to re-run).
 *
 * Backfills, preserving all existing dev data (spec §36):
 *   1. PasswordCredential rows from the pre-migration User.passwordHash
 *      column (recovered copy at db/backups/pre-phase1-HEAD.db, matched by
 *      email — the schema push dropped the column before a same-DB backfill
 *      was possible; see docs/PHASE1_PLAN.md §3 and worklog).
 *   2. OWNER Membership for every Organization.ownerUserId.
 *   3. ApiKey.organizationId + UsageEvent.organizationId from the creator's
 *      personal organization (tenant anchors, Phase 1 §24/§27).
 *   4. Plan.maxMembers defaults (free = 3 seats: OWNER + 2).
 *
 * Usage: bun scripts/migrate-phase1.ts
 */
import { PrismaClient } from "@prisma/client";
import { randomUUID } from "crypto";
import { cpSync, existsSync, mkdirSync } from "fs";

const MAIN_DB = "file:/home/z/my-project/db/custom.db";
const RECOVERY_DB = "file:/home/z/my-project/db/backups/pre-phase1-HEAD.db";

const db = new PrismaClient({ datasources: { db: { url: MAIN_DB } } });

async function main(): Promise<void> {
  // Safety snapshot before any mutation.
  if (existsSync("/home/z/my-project/db/custom.db")) {
    mkdirSync("/home/z/my-project/db/backups", { recursive: true });
    cpSync(
      "/home/z/my-project/db/custom.db",
      `/home/z/my-project/db/backups/pre-phase1-${Date.now()}.db`,
    );
    console.log("[migrate] safety snapshot written to db/backups/");
  }

  // ── 1. PasswordCredential from the recovered passwordHash column ──
  await db.$executeRawUnsafe(
    `ATTACH DATABASE '${RECOVERY_DB.replace("file:", "")}' AS recovery`,
  );
  const restored = await db.$executeRawUnsafe(
    `INSERT INTO PasswordCredential (id, userId, passwordHash, createdAt, updatedAt)
     SELECT lower(hex(randomblob(32))), u.id, r.passwordHash, strftime('%Y-%m-%d %H:%M:%f','now'), strftime('%Y-%m-%d %H:%M:%f','now')
     FROM User u
     JOIN recovery.User r ON lower(r.email) = lower(u.email)
     WHERE r.passwordHash IS NOT NULL AND r.passwordHash != ''
       AND NOT EXISTS (SELECT 1 FROM PasswordCredential pc WHERE pc.userId = u.id)`,
  );
  await db.$executeRawUnsafe(`DETACH DATABASE recovery`);
  console.log(`[migrate] PasswordCredential rows restored: ${restored}`);

  // ── 2. OWNER memberships for every organization owner ──
  const orgs = await db.organization.findMany({ select: { id: true, ownerUserId: true } });
  let ownerMemberships = 0;
  for (const org of orgs) {
    const existing = await db.membership.findUnique({
      where: { organizationId_userId: { organizationId: org.id, userId: org.ownerUserId } },
    });
    if (!existing) {
      await db.membership.create({
        data: { organizationId: org.id, userId: org.ownerUserId, role: "OWNER" },
      });
      ownerMemberships++;
    } else if (existing.role !== "OWNER") {
      await db.membership.update({ where: { id: existing.id }, data: { role: "OWNER" } });
    }
  }
  console.log(`[migrate] OWNER memberships created: ${ownerMemberships} (orgs checked: ${orgs.length})`);

  // ── 3. Tenant anchors: ApiKey / UsageEvent → creator's personal org ──
  const users = await db.user.findMany({
    select: { id: true, ownedOrganizations: { select: { id: true }, take: 1 } },
  });
  const orgByUser = new Map<string, string>();
  for (const u of users) {
    if (u.ownedOrganizations[0]) orgByUser.set(u.id, u.ownedOrganizations[0].id);
  }

  let keysFixed = 0;
  const orphanKeys = await db.apiKey.findMany({ where: { organizationId: null } });
  for (const key of orphanKeys) {
    const orgId = orgByUser.get(key.userId);
    if (orgId) {
      await db.apiKey.update({ where: { id: key.id }, data: { organizationId: orgId } });
      keysFixed++;
    }
  }
  console.log(`[migrate] ApiKey.organizationId backfilled: ${keysFixed} (orphan keys left: ${orphanKeys.length - keysFixed})`);

  let eventsFixed = 0;
  const orphanEvents = await db.usageEvent.findMany({ where: { organizationId: null } });
  for (const ev of orphanEvents) {
    const orgId = orgByUser.get(ev.userId);
    if (orgId) {
      await db.usageEvent.update({ where: { id: ev.id }, data: { organizationId: orgId } });
      eventsFixed++;
    }
  }
  console.log(`[migrate] UsageEvent.organizationId backfilled: ${eventsFixed} (orphan events left: ${orphanEvents.length - eventsFixed})`);

  // ── 4. Plan seat limits (§20 — DB-backed, not hardcoded) ──
  const seatLimits: Record<string, number> = { free: 3, pro: 10, max: 25 };
  for (const [planId, maxMembers] of Object.entries(seatLimits)) {
    await db.plan.updateMany({ where: { id: planId }, data: { maxMembers } });
  }
  console.log(`[migrate] Plan.maxMembers set: ${JSON.stringify(seatLimits)}`);

  // ── Verification summary ──
  const [credCount, usersNoCred, membersNoOwner] = await Promise.all([
    db.passwordCredential.count(),
    db.user.findMany({ where: { passwordCredential: null }, select: { email: true } }),
    db.organization.findMany({
      where: { memberships: { none: { role: "OWNER" } } },
      select: { name: true },
    }),
  ]);
  console.log("[migrate] verification:");
  console.log(`  - password credentials: ${credCount}`);
  console.log(`  - users without a password credential (OAuth-only OK): ${usersNoCred.length ? usersNoCred.map((u) => u.email).join(", ") : "none"}`);
  console.log(`  - organizations without an OWNER membership: ${membersNoOwner.length ? membersNoOwner.map((o) => o.name).join(", ") : "none"}`);
  console.log(`[migrate] migration id ${randomUUID()} complete`);
}

main()
  .catch((err) => {
    console.error("[migrate] FAILED:", err);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
