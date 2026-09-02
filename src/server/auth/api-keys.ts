/**
 * API key generation & authentication.
 *
 * - Raw keys: `tf_live_` + 32 cryptographically random base62 chars (≈190 bits).
 * - Shown exactly once at creation; only a peppered SHA-256 hash is stored.
 * - Display prefix (first 12 chars) stored for identification.
 */
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { serverEnv } from "@/server/env";
import { sha256 } from "@/server/auth/session";
import { ensurePersonalOrg } from "@/server/tenancy/org-service";
import { ensureCurrentPeriod } from "@/server/billing/subscription";
import type { ApiKey, CreditAccount, Plan, Subscription, User } from "@prisma/client";

const KEY_PREFIX = "tf_live_";
const RANDOM_LENGTH = 32;
const BASE62 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

export type ApiKeyContext = {
  apiKeyId: string;
  userId: string;
  keyName: string;
  permissions: string[];
};

export function generateRawKey(): { raw: string; prefix: string; keyHash: string } {
  const bytes = new Uint8Array(RANDOM_LENGTH);
  crypto.getRandomValues(bytes);
  let random = "";
  for (let i = 0; i < RANDOM_LENGTH; i++) random += BASE62[bytes[i] % 62];
  const raw = `${KEY_PREFIX}${random}`;
  return { raw, prefix: raw.slice(0, KEY_PREFIX.length + 8), keyHash: hashRawKey(raw) };
}

export function hashRawKey(raw: string): string {
  return sha256(`${serverEnv.pepper}:${raw}`);
}

/** Extract the bearer key from an Authorization header. */
export function extractBearerKey(req: NextRequest): string | null {
  const header = req.headers.get("authorization");
  if (!header) return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

/**
 * Explicit gateway key context: the ApiKey row plus the billing identity
 * resolved through the caller's ORGANIZATION (spec §3).
 */
export type AuthenticatedKey = Omit<ApiKey, "permissions"> & {
  /** Billing owner organization id (ApiKey → Organization → Subscription). */
  organizationId: string;
  permissions: string[];
  /** The creating member (attribution) with the ORG billing state attached. */
  user: Omit<User, "subscriptions" | "creditAccounts" | "ownedOrganizations"> & {
    subscription: (Subscription & { plan: Plan }) | null;
    creditAccount: CreditAccount | null;
  };
};

export type KeyAuthenticationResult =
  | { ok: true; key: AuthenticatedKey }
  | { ok: false; error: string; status: number };

/**
 * Authenticate an API key and load the full gateway context:
 * key → ORGANIZATION (key owner, Phase 1 §27) → subscription (lazy rollover)
 * → plan → credit account. Entitlement/credit/rate-limit checks happen
 * downstream in the gateway pipeline. Legacy user-anchored keys (created
 * before Phase 1) are lazily adopted into the creator's personal org.
 */
export async function authenticateApiKey(raw: string): Promise<KeyAuthenticationResult> {
  if (!raw.startsWith(KEY_PREFIX)) {
    return { ok: false, error: "Malformed API key", status: 401 };
  }
  const key = await db.apiKey.findUnique({
    where: { keyHash: hashRawKey(raw) },
    include: { user: true },
  });
  if (!key || key.status !== "ACTIVE") {
    return { ok: false, error: "Invalid or revoked API key", status: 401 };
  }

  // Keys are ORGANIZATION-owned (§27). Legacy rows without an org anchor are
  // adopted into the creator's personal organization lazily.
  let orgId = key.organizationId;
  if (!orgId) {
    const org = await ensurePersonalOrg(key.user);
    await db.apiKey.update({ where: { id: key.id }, data: { organizationId: org.id } }).catch(() => undefined);
    orgId = org.id;
  }
  const org = await db.organization.findUnique({
    where: { id: orgId },
    include: { subscription: { include: { plan: true } }, creditAccount: true },
  });
  if (!org) return { ok: false, error: "Organization could not be resolved", status: 500 };

  let subscription = org.subscription ?? null;
  if (subscription) {
    // Lazy monthly rollover (entitlement-gated for Stripe subscriptions).
    subscription = await ensureCurrentPeriod(subscription.id);
  }

  // Relation fields are never loaded here; strip them from the type so the
  // gateway context cannot accidentally depend on unloaded data.
  const userFields = key.user as Omit<User, "subscriptions" | "creditAccounts" | "ownedOrganizations">;

  return {
    ok: true,
    key: {
      ...key,
      organizationId: org.id,
      user: {
        ...userFields,
        subscription,
        creditAccount: org.creditAccount ?? null,
      },
      permissions: safeParsePermissions(key.permissions),
    },
  };
}

function safeParsePermissions(json: string | null): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}
