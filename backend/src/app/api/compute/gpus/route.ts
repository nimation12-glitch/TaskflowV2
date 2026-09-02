/**
 * GET /api/compute/gpus — public GPU catalog (example pricing, configurable).
 * Rental features are Phase 9; this endpoint powers the compute page preview.
 */
import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export async function GET() {
  const gpus = await db.gpuType.findMany({
    where: { isActive: true },
    orderBy: { sortOrder: "asc" },
  });
  return NextResponse.json({
    gpus: gpus.map((g) => ({
      id: g.id,
      displayName: g.displayName,
      vramGb: g.vramGb,
      hourlyRateMicros: g.hourlyRateMicros,
      description: g.description,
      isActive: g.isActive,
    })),
  });
}
