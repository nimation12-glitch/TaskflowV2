/**
 * GET /api/auth/providers — real OAuth configuration state (Phase 1 §4, §30).
 * The login UI renders ENABLED buttons only for configured providers; missing
 * credentials produce a disabled button with a configuration hint. This is
 * reporting only — no credential values are ever returned (§11, §43).
 */
import { NextResponse } from "next/server";
import { serverEnv } from "@/server/env";

function providerState(id: string | undefined, secret: string | undefined): { enabled: boolean } {
  return { enabled: Boolean(id && secret) };
}

export async function GET() {
  return NextResponse.json({
    providers: {
      google: providerState(serverEnv.googleClientId, serverEnv.googleClientSecret),
      microsoft: providerState(serverEnv.microsoftClientId, serverEnv.microsoftClientSecret),
      github: providerState(serverEnv.githubClientId, serverEnv.githubClientSecret),
    },
  });
}
