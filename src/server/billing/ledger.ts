/**
 * Credit ledger — append-only, transactional, organization-anchored.
 *
 * INVARIANTS (see MASTER_PROJECT_CONTEXT §17):
 *  1. Rows are never updated or deleted — corrections are new rows (REFUND/ADJUSTMENT).
 *  2. Every mutation inserts a ledger row AND updates the CreditAccount aggregate
 *     inside the same Prisma transaction.
 *  3. balanceAfterMicros snapshots the post-transaction balance for reconciliation.
 *  4. Debits never drive the balance negative — the caller checks affordability first
 *     and the transaction re-asserts it (guarded debit).
 *  5. Grants derived from Stripe carry a `uniqueGrantKey`; the UNIQUE constraint
 *     makes duplicate fulfillment (webhook retries, rollover races) physically
 *     impossible — a repeated grant throws instead of double-crediting.
 */
import { db } from "@/lib/db";
import { roundMicros } from "@/lib/money";
import type { CreditAccount, CreditTransaction } from "@prisma/client";

export type LedgerType =
  | "MONTHLY_GRANT"
  | "USAGE"
  | "PURCHASE"
  | "REFUND"
  | "ADJUSTMENT"
  | "GPU_RENTAL";

/**
 * Resolve the org's credit account (org-anchored, Phase 1). Falls back to the
 * legacy user-keyed account for rows created before the org migration, then
 * re-anchors it when organizationId is supplied.
 */
export async function getOrCreateCreditAccount(
  userId: string,
  organizationId?: string | null,
): Promise<CreditAccount> {
  const existing = organizationId
    ? await db.creditAccount.findUnique({ where: { organizationId } })
    : await db.creditAccount.findFirst({ where: { userId, organizationId: null } });
  if (existing) {
    return existing;
  }
  // Legacy account keyed by user only (pre-org row without an anchor).
  const legacy = organizationId
    ? await db.creditAccount.findFirst({ where: { userId, organizationId: null } })
    : null;
  if (legacy) {
    return db.creditAccount.update({ where: { id: legacy.id }, data: { organizationId } });
  }
  return db.creditAccount.create({ data: { userId, organizationId: organizationId ?? null, balanceMicros: 0 } });
}

export type GrantOpts = {
  userId: string;
  organizationId?: string | null;
  amountMicros: number;
  type: Extract<LedgerType, "MONTHLY_GRANT" | "PURCHASE" | "REFUND" | "ADJUSTMENT">;
  description: string;
  referenceId?: string;
  /** Idempotency key for Stripe-derived grants (unique; duplicates throw). */
  uniqueGrantKey?: string;
  metadata?: Record<string, unknown>;
  periodStart?: Date;
  periodEnd?: Date;
};

export type GrantResult =
  | { granted: true; transaction: CreditTransaction }
  | { granted: false; reason: "duplicate_grant" };

/**
 * Credit a customer (grant/purchase/refund). amount must be > 0.
 * When `uniqueGrantKey` is supplied and already exists, returns
 * { granted: false, reason: "duplicate_grant" } instead of throwing, so
 * webhook retries and the lazy rollover converge without side effects.
 */
export async function grantCredits(opts: GrantOpts): Promise<GrantResult> {
  const amount = roundMicros(opts.amountMicros);
  if (amount <= 0) throw new Error("grantCredits requires a positive amount");

  if (opts.uniqueGrantKey) {
    const dupe = await db.creditTransaction.findUnique({ where: { uniqueGrantKey: opts.uniqueGrantKey } });
    if (dupe) return { granted: false, reason: "duplicate_grant" };
  }

  try {
    const transaction = await db.$transaction(async (tx) => {
      // Org-anchored account resolution (Phase 1); legacy user-keyed rows are
      // re-anchored lazily when organizationId is known.
      const account = opts.organizationId
        ? await tx.creditAccount.upsert({
            where: { organizationId: opts.organizationId },
            create: { userId: opts.userId, organizationId: opts.organizationId, balanceMicros: 0 },
            update: {},
          })
        : await tx.creditAccount.create({
            data: { userId: opts.userId, organizationId: null, balanceMicros: 0 },
          });
      const balanceAfter = account.balanceMicros + amount;
      await tx.creditAccount.update({
        where: { id: account.id },
        data: { balanceMicros: balanceAfter },
      });
      const metadata = {
        ...(opts.periodStart ? { period_start: opts.periodStart.toISOString() } : {}),
        ...(opts.periodEnd ? { period_end: opts.periodEnd.toISOString() } : {}),
        ...(opts.metadata ?? {}),
        organization_id: opts.organizationId ?? account.organizationId ?? undefined,
      };
      return tx.creditTransaction.create({
        data: {
          accountId: account.id,
          organizationId: opts.organizationId ?? account.organizationId,
          userId: opts.userId,
          type: opts.type,
          amountMicros: amount,
          balanceAfterMicros: balanceAfter,
          description: opts.description,
          referenceId: opts.referenceId,
          uniqueGrantKey: opts.uniqueGrantKey,
          metadata: Object.values(metadata).some((v) => v !== undefined)
            ? JSON.stringify(metadata)
            : undefined,
        },
      });
    });
    return { granted: true, transaction };
  } catch (err) {
    // Concurrent duplicate grant (unique violation on uniqueGrantKey).
    if (
      opts.uniqueGrantKey &&
      err instanceof Error &&
      (err.message.includes("Unique constraint") || err.message.includes("UNIQUE constraint"))
    ) {
      return { granted: false, reason: "duplicate_grant" };
    }
    throw err;
  }
}

export type DebitOpts = {
  userId: string;
  organizationId?: string | null;
  amountMicros: number;
  type: Extract<LedgerType, "USAGE" | "GPU_RENTAL" | "ADJUSTMENT">;
  description: string;
  referenceId?: string;
  metadata?: Record<string, unknown>;
  allowNegative?: boolean; // only for internal adjustments; never for customer usage
};

export type DebitResult =
  | { ok: true; transaction: CreditTransaction | null; balanceMicros: number }
  | { ok: false; reason: "INSUFFICIENT_CREDITS"; balanceMicros: number };

/**
 * Debit credits atomically with a balance guard. The guard is re-asserted
 * inside the transaction so concurrent requests cannot overdraw.
 */
export async function debitCredits(opts: DebitOpts): Promise<DebitResult> {
  const amount = roundMicros(opts.amountMicros);
  if (amount < 0) throw new Error("debitCredits received a negative amount");
  if (amount === 0) {
    const acct = await getOrCreateCreditAccount(opts.userId, opts.organizationId);
    return { ok: true, transaction: null, balanceMicros: acct.balanceMicros };
  }

  return db.$transaction(async (tx) => {
    // Org-anchored account resolution (Phase 1). Sequentialise per-account
    // writes (SQLite: single writer anyway; explicit for clarity).
    const account = opts.organizationId
      ? await tx.creditAccount.upsert({
          where: { organizationId: opts.organizationId },
          create: { userId: opts.userId, organizationId: opts.organizationId, balanceMicros: 0 },
          update: {},
        })
      : await tx.creditAccount.create({
          data: { userId: opts.userId, organizationId: null, balanceMicros: 0 },
        });
    if (!opts.allowNegative && account.balanceMicros < amount) {
      return { ok: false as const, reason: "INSUFFICIENT_CREDITS" as const, balanceMicros: account.balanceMicros };
    }
    const balanceAfter = account.balanceMicros - amount;
    await tx.creditAccount.update({
      where: { id: account.id },
      data: { balanceMicros: balanceAfter },
    });
    const transaction = await tx.creditTransaction.create({
      data: {
        accountId: account.id,
        organizationId: opts.organizationId ?? account.organizationId,
        userId: opts.userId,
        type: opts.type,
        amountMicros: -amount,
        balanceAfterMicros: balanceAfter,
        description: opts.description,
        referenceId: opts.referenceId,
        metadata: opts.metadata ? JSON.stringify(opts.metadata) : undefined,
      },
    });
    return { ok: true as const, transaction, balanceMicros: balanceAfter };
  });
}
