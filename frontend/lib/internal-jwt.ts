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
 * Mints a short-lived (60s) HS256 JWT asserting { sub, org_id, role }. The
 * FastAPI backend verifies this with the same AUTH_SECRET (see
 * backend/app/auth/internal.py). The browser never sees this token — it is
 * minted and used entirely on the Next.js server for each backend call.
 */
export async function signBackendToken(params: {
  userId: string;
  organizationId: string;
  role: "OWNER" | "ADMIN" | "MEMBER";
}): Promise<string> {
  return new SignJWT({ org_id: params.organizationId, role: params.role })
    .setProtectedHeader({ alg: ALG })
    .setSubject(params.userId)
    .setIssuedAt()
    .setExpirationTime("60s")
    .sign(getSecret());
}
