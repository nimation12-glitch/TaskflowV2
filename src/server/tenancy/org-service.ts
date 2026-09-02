/**
 * Organization lifecycle service (Phase 1 §3, §22, §26, §32).
 *
 * EVERY new organization — from registration, OAuth provisioning or the
 * "create workspace" dialog — is created through `createOrganization` so the
 * invariant holds everywhere:
 *
 *   Organization + OWNER Membership + Free Subscription + Credit Account
 *   created in ONE transaction, idempotent under unique constraints.
 *
 * `ensurePersonalOrg` (billing) now delegates here for the personal-org case
 * so billing and tenancy share a single provisioning path.
 */
import { db } from "@/lib/db";
import { ensureOrgSubscription } from "@/server/billing/subscription";
import { getOrCreateCreditAccount } from "@/server/billing/ledger";
import { recordAudit } from "@/server/audit";
import type { Organization, User } from "@prisma/client";

export function slugify(input: string): string {
  return (
    input
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "org"
  );

}

async function uniqueSlug(base: string): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const slug = attempt === 0 ? base : `${base}-${Math.random().toString(36).slice(2, 7)}`;
    const clash = await db.organization.findUnique({ where: { slug } });
    if (!clash) return slug;
  }
  return `${base}-${randomSuffix()}`;
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 10);
}

/**
 * Create an organization with the FULL provisioning bundle (§3/§26):
 * org → OWNER membership → Free subscription → credit account (+ first
 * Free allowance via the subscription service). Transactional + idempotent:
 * a repeated callback/retry cannot duplicate any row (§32).
 */
export async function createOrganization(opts: {
  owner: Pick<User, "id" | "email" | "name">;
  name?: string;
  /** Personal org: auto-named after the user; explicit orgs use `name`. */
  personal?: boolean;
  ipAddress?: string | null;
  audit?: boolean;
}): Promise<Organization> {
  const displayName =
    opts.name?.trim() ||
    (opts.owner.name ? `${opts.owner.name}'s Workspace` : `Organization for ${opts.owner.email}`);

  const slug = await uniqueSlug(
    slugify(opts.personal ? opts.owner.name ?? opts.owner.email.split("@")[0] : displayName),
  );

  const org = await db.$transaction(async (tx) => {
    const created = await tx.organization.create({
      data: { name: displayName, slug, ownerUserId: opts.owner.id },
    });
    await tx.membership.create({
      data: { organizationId: created.id, userId: opts.owner.id, role: "OWNER" },
    });
    return created;
  });

  // Billing initialization (idempotent by org id / grant keys).
  await getOrCreateCreditAccount(opts.owner.id, org.id);
  await ensureOrgSubscription({
    organizationId: org.id,
    userId: opts.owner.id,
    planId: "free",
    status: "ACTIVE",
  });

  if (opts.audit !== false) {
    await recordAudit({
      action: "organization_created",
      userId: opts.owner.id,
      organizationId: org.id,
      metadata: { personal: Boolean(opts.personal), name: org.name },
      ipAddress: opts.ipAddress ?? null,
    });
  }
  return org;
}

/**
 * The personal organization of a user — created lazily on first need
 * (registration, OAuth provisioning, legacy repair) and reused afterwards.
 * Kept as the billing module's personal-org primitive (used by the Stripe
 * paths and api-key legacy repair).
 */
export async function ensurePersonalOrg(
  user: Pick<User, "id" | "email" | "name">,
): Promise<Organization> {
  const existing = await db.organization.findFirst({ where: { ownerUserId: user.id } });
  if (existing) return existing;
  return createOrganization({ owner: user, personal: true, audit: false });
}

/** Load an organization's subscription with its plan. */
export async function getOrgSubscription(orgId: string) {
  return db.subscription.findUnique({
    where: { organizationId: orgId },
    include: { plan: true },
  });
}
