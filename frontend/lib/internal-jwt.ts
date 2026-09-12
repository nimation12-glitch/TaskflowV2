import "server-only";
import { SignJWT } from "jose";

const ALG = "HS256";

function getSecret(): Uint8Array {
  const secret = process.env.AUTH_SECRET;
  if (!secret) {
    throw new Error("AUTH_SECRET is not set — required to sign backend request tokens");
  }
  return new TextEncoder().encode(secret);
}

/**
 * Mints a short-lived (60s) HS256 JWT asserting { sub, org_id, role,
 * is_platform_admin }. The FastAPI backend verifies this with the same
 * AUTH_SECRET (see backend/app/auth/internal.py). The browser never sees
 * this token — it is minted and used entirely on the Next.js server for
 * each backend call.
 *
 * is_platform_admin is looked up server-side (lib/platform-admin.ts) at
 * mint time on every call — it is never accepted as an input from anywhere
 * that could be client-influenced.
 */
export async function signBackendToken(params: {
  userId: string;
  organizationId: string;
  role: "OWNER" | "ADMIN" | "MEMBER";
  isPlatformAdmin: boolean;
}): Promise<string> {
  return new SignJWT({ org_id: params.organizationId, role: params.role, is_platform_admin: params.isPlatformAdmin })
    .setProtectedHeader({ alg: ALG })
    .setSubject(params.userId)
    .setIssuedAt()
    .setExpirationTime("60s")
    .sign(getSecret());
}
