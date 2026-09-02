/** GET /api/billing/invoices — billing history for the ACTIVE organization (§24). */
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

  const invoices = await db.invoice.findMany({
    where: { organizationId: orgId },
    orderBy: { createdAt: "desc" },
    take: 50,
  });

  return NextResponse.json({
    invoices: invoices.map((i) => ({
      id: i.id,
      number: i.number,
      description: i.description,
      amountMicros: i.amountMicros,
      amountGBP: i.amountMicros / MICRO_PER_POUND,
      currency: i.currency,
      status: i.status,
      periodStart: i.periodStart,
      periodEnd: i.periodEnd,
      hostedUrl: i.hostedUrl,
      createdAt: i.createdAt,
    })),
  });
}
