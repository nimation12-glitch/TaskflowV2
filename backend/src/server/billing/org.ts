/**
 * Organization resolution (spec §3 — User → Organization → Stripe Customer
 * → Stripe Subscription).
 *
 * Provisioning lives in `src/server/tenancy/org-service.ts` (Phase 1) so
 * billing and tenancy share ONE creation path (org + OWNER membership +
 * Free subscription + credit account, transactional & idempotent).
 */
import { db } from "@/lib/db";
import type { Organization, User } from "@prisma/client";

export { ensurePersonalOrg } from "@/server/tenancy/org-service";
import { ensurePersonalOrg } from "@/server/tenancy/org-service";

/**
 * Resolve the billing organization for a session user (lazily backfills the
 * personal org for accounts created before organizations existed).
 *
 * NOTE: dashboard routes now resolve the ACTIVE organization through the
 * membership-validated org context (`server/tenancy/authz.ts`); this helper
 * remains for billing internals that need the personal/billing org of a user.
 */
export async function getBillingOrg(user: Pick<User, "id" | "email" | "name">): Promise<Organization> {
  return ensurePersonalOrg(user);
}

/** Load an organization's subscription with its plan. */
export async function getOrgSubscription(orgId: string) {
  return db.subscription.findUnique({
    where: { organizationId: orgId },
    include: { plan: true },
  });
}
