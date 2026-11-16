import { NextResponse } from "next/server";
import {
  backendFetch,
  NoActiveOrganizationError,
  UnauthenticatedError,
} from "@/lib/backend-client";

/**
 * Read-only download of the organization's account statement.
 *
 * The browser never talks to the FastAPI backend directly for session-bound
 * routes (see lib/backend-client.ts) — this route handler proxies it with a
 * short-lived internal JWT. The backend endpoint is OWNER-only and appends a
 * new immutable snapshot each time it runs, so a download is both a user
 * artifact and an auditable ledger event (its id + hash come back in the
 * JSON payload itself).
 */
export async function GET() {
  try {
    const res = await backendFetch("/billing/statement");
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return NextResponse.json(
        { error: detail || "Statement unavailable" },
        { status: res.status }
      );
    }
    const payload = await res.json();
    const today = new Date().toISOString().slice(0, 10);
    const snapshotId = typeof payload.statement_id === "string" ? payload.statement_id.slice(0, 8) : "latest";
    return new NextResponse(JSON.stringify(payload, null, 2), {
      headers: {
        "Content-Type": "application/json",
        "Content-Disposition": `attachment; filename="taskflow-account-statement-${today}-${snapshotId}.json"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    if (err instanceof UnauthenticatedError) {
      return NextResponse.json({ error: "Not signed in" }, { status: 401 });
    }
    if (err instanceof NoActiveOrganizationError) {
      return NextResponse.json({ error: "No active organization" }, { status: 403 });
    }
    return NextResponse.json({ error: "Statement unavailable" }, { status: 500 });
  }
}
