/**
 * GET /api/credits — credit account + append-only ledger (most recent 100 rows).
 * The balance shown is the transactional aggregate, auditable against the ledger.
 * Rows are anchored to the caller's ORGANIZATION (billing owner, §3) and carry
 * the Stripe reconciliation metadata where applicable (§18).
 */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getOrgContext, OrgContextError } from "@/server/tenancy/authz";
import { MICRO_PER_POUND } from "@/lib/money";

export async function GET(req: NextRequest) {
  let orgId: string;
  try {
    const ctx = await getOrgContext(req);
    orgId = ctx.organization.id;
  } catch (err) {
    if (err instanceof OrgContextError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
  const account = await db.creditAccount.findUnique({ where: { organizationId: orgId } });
  const transactions = await db.creditTransaction.findMany({
    where: { organizationId: orgId },
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  return NextResponse.json({
    balanceMicros: account?.balanceMicros ?? 0,
    balanceGBP: (account?.balanceMicros ?? 0) / MICRO_PER_POUND,
    autoTopUp: account
      ? {
          enabled: account.autoTopUpEnabled,
          thresholdMicros: account.autoTopUpThresholdMicros,
          amountMicros: account.autoTopUpAmountMicros,
        }
      : { enabled: false, thresholdMicros: null, amountMicros: null },
    transactions: transactions.map((t) => {
      let metadata: Record<string, unknown> | null = null;
      if (t.metadata) {
        try {
          metadata = JSON.parse(t.metadata) as Record<string, unknown>;
        } catch {
          metadata = null;
        }
      }
      return {
        id: t.id,
        type: t.type,
        amountMicros: t.amountMicros,
        amountGBP: t.amountMicros / MICRO_PER_POUND,
        balanceAfterMicros: t.balanceAfterMicros,
        balanceAfterGBP: t.balanceAfterMicros / MICRO_PER_POUND,
        description: t.description,
        referenceId: t.referenceId,
        uniqueGrantKey: t.uniqueGrantKey,
        stripe: metadata
          ? {
              paymentIntentId: (metadata.stripe_payment_intent_id as string) ?? null,
              checkoutSessionId: (metadata.stripe_checkout_session_id as string) ?? null,
              eventId: (metadata.stripe_event_id as string) ?? null,
              invoiceId: (metadata.stripe_invoice_id as string) ?? null,
            }
          : null,
        createdAt: t.createdAt,
      };
    }),
  });
}
