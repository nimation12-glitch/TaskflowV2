/**
 * Grants platform-admin status to a specific account by email. This is the
 * ONLY path that sets isPlatformAdmin=true — there is deliberately no API
 * route or UI control for it, per the requirement that admin status can
 * only come from direct issuance, not from any app-reachable surface.
 *
 * Run after `npx prisma migrate dev` (or deploy) has applied the
 * isPlatformAdmin column:
 *
 *   npx tsx scripts/set-platform-admin.ts nimation12@gmail.com
 *
 * Safe to re-run — it's an idempotent upsert-style update, not an insert.
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const email = process.argv[2];
  if (!email) {
    console.error("Usage: npx tsx scripts/set-platform-admin.ts <email>");
    process.exit(1);
  }

  const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
  if (!user) {
    console.error(`No user found with email ${email}. They must sign up first — this script only promotes an existing account.`);
    process.exit(1);
  }

  if (user.isPlatformAdmin) {
    console.log(`${email} is already a platform admin. Nothing to do.`);
    return;
  }

  await prisma.user.update({ where: { id: user.id }, data: { isPlatformAdmin: true } });
  console.log(`Granted platform-admin to ${email} (user id ${user.id}).`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
