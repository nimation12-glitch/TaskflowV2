import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { billingMode } from "@/server/stripe";
import { registrySnapshot } from "@/server/providers/registry";
import { serverEnv } from "@/server/env";
import { billingConfigIssues } from "@/server/startup";
import { OAUTH_PROVIDERS, isProviderConfigured, providerCallbackUrl } from "@/server/auth/authjs/provider-map";
import { smsTransportStatus } from "@/server/sms";

export async function GET() {
  let database = "ok";
  try {
    await db.plan.count();
  } catch {
    database = "error";
  }

  const configIssues = billingConfigIssues();
  const mode = billingMode();

  // Identity posture (configuration reporting only — no secret values, §43).
  const oauth = Object.fromEntries(
    OAUTH_PROVIDERS.map((p) => [p, { enabled: isProviderConfigured(p), callbackUrl: providerCallbackUrl(p) }]),
  );

  return NextResponse.json({
    status: database === "ok" && (mode === "unconfigured" ? true : configIssues.length === 0) ? "ok" : "degraded",
    service: "taskflow-api",
    version: "0.3.0",
    time: new Date().toISOString(),
    database,
    billing: mode,
    billingConfigIssues: configIssues,
    keyPepperConfigured: serverEnv.apiKeyPepperConfigured,
    providers: registrySnapshot(),
    identity: {
      framework: "auth.js v5 (database sessions)",
      oauth,
      emailTransport: serverEnv.emailTransport,
      sms: smsTransportStatus(),
    },
  });
}
