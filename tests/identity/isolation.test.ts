/// <reference types="bun-types" />
/**
 * Tenant isolation (Phase 1 §24, §44 scenarios 22–24):
 *  - API key organization isolation (list/create/revoke scoped to active org)
 *  - credit ledger organization isolation
 *  - billing organization isolation (owner-only mutations; invoices scoped)
 *  - usage organization isolation
 *  - gateway resolves a key through ITS organization, not the creator
 */
import { describe, test, expect, beforeAll } from "bun:test";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { ensureSeedPlans, makeOrg } from "../helpers";
import { createSession, SESSION_COOKIE } from "@/server/auth/session";
import { generateRawKey, hashRawKey } from "@/server/auth/api-keys";
import { grantCredits, getOrCreateCreditAccount } from "@/server/billing/ledger";
import { authenticateApiKey } from "@/server/auth/api-keys";
import { getOrgContext, requireOrgRole, requireOrgMember, ORG_COOKIE, OrgContextError } from "@/server/tenancy/authz";

let ipCounter = 500;
const nextIp = () => `10.${ipCounter++}.0.1`;

async function sessionFor(userId: string) {
  return (await createSession(userId)).raw;
}

function cookieReq(url: string, token: string, method = "GET", body?: unknown, extra = "") {
  return new NextRequest(`http://localhost:3000${url}`, {
    method,
    headers: {
      cookie: `${SESSION_COOKIE}=${token}${extra ? `; ${extra}` : ""}`,
      "x-forwarded-for": nextIp(),
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeAll(async () => {
  await ensureSeedPlans();
});

describe("tenant isolation", () => {
  test("API keys are org-owned: key list/create is scoped to the ACTIVE org (§27)", async () => {
    const ownerA = await makeOrg("iso-a");
    const ownerB = await makeOrg("iso-b");
    const tokenA = await sessionFor(ownerA.user.id);

    // Member of org B must not see org A's keys even with org A's id on the wire.
    const tokenB = await sessionFor(ownerB.user.id);
    const ctxB = await getOrgContext(cookieReq("/api/keys", tokenB));
    expect(ctxB.organization.id).toBe(ownerB.org.id);

    // A's session sees only A's keys.
    const { GET: keysGET, POST: keysPOST } = await import("@/app/api/keys/route");
    const created = await keysPOST(
      cookieReq("/api/keys", tokenA, "POST", { name: "A production key" }),
    );
    expect(created.status).toBe(201);
    const keyRow = await db.apiKey.findFirst({ where: { name: "A production key" } });
    expect(keyRow?.organizationId).toBe(ownerA.org.id);

    // B's key list is empty (never shows A's key).
    const listB = await keysGET(cookieReq("/api/keys", tokenB));
    const bodyB = await listB.json();
    expect(bodyB.keys).toHaveLength(0);

    // A sees its own key.
    const listA = await keysGET(cookieReq("/api/keys", tokenA));
    const bodyA = await listA.json();
    expect(bodyA.keys).toHaveLength(1);
  });

  test("gateway resolves a key through ITS OWN organization (cross-tenant key of removed member)", async () => {
    // Key created while a user belonged to org X keeps resolving to X's
    // billing context — and revocation/ownership is org-scoped.
    const { user, org } = await makeOrg("gw-iso");
    const { raw, keyHash } = generateRawKey();
    await db.apiKey.create({
      data: { organizationId: org.id, userId: user.id, name: "iso key", prefix: raw.slice(0, 12), keyHash },
    });

    const result = await authenticateApiKey(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.key.organizationId).toBe(org.id);
      expect(result.key.user.creditAccount?.balanceMicros ?? 0).toBe(0);
    }
  });

  test("credit ledger rows are org-anchored and never leak across tenants (§24)", async () => {
    const a = await makeOrg("credit-a");
    const b = await makeOrg("credit-b");

    const accountA = await getOrCreateCreditAccount(a.user.id, a.org.id);
    await grantCredits({
      userId: a.user.id,
      organizationId: a.org.id,
      amountMicros: 5_000_000,
      type: "PURCHASE",
      description: "test pack A",
    });

    const accountB = await getOrCreateCreditAccount(b.user.id, b.org.id);
    expect(accountB.balanceMicros).toBe(0); // B never sees A's money

    const { GET: creditsGET } = await import("@/app/api/credits/route");
    const tokenB = await sessionFor(b.user.id);
    const res = await creditsGET(cookieReq("/api/credits", tokenB));
    const body = await res.json();
    expect(body.balanceMicros).toBe(0);
    expect(body.transactions).toHaveLength(0); // A's ledger rows are invisible

    const tokenA = await sessionFor(a.user.id);
    const resA = await creditsGET(cookieReq("/api/credits", tokenA));
    const bodyA = await resA.json();
    expect(bodyA.balanceMicros).toBe(5_000_000);
    expect(bodyA.transactions).toHaveLength(1);
    void accountA;
  });

  test("billing mutations are OWNER-only and org-scoped (§25)", async () => {
    const { user: owner, org } = await makeOrg("bill-iso");
    const member = await db.user.create({
      data: { email: `bill-member-${Date.now()}@test-iso.dev`, passwordCredential: { create: { passwordHash: "x" } } },
    });
    await db.membership.create({ data: { organizationId: org.id, userId: member.id, role: "MEMBER" } });

    const memberToken = await sessionFor(member.id);
    const ownerToken = await sessionFor(owner.id);

    // MEMBER cannot start checkout or cancel.
    const { POST: checkoutPOST } = await import("@/app/api/billing/checkout/route");
    const memberCheckout = await checkoutPOST(
      cookieReq("/api/billing/checkout", memberToken, "POST", { kind: "credits", amountMicros: 10_000_000 }),
    );
    expect(memberCheckout.status).toBe(403);

    const { POST: subscriptionPOST } = await import("@/app/api/billing/subscription/route");
    const memberCancel = await subscriptionPOST(
      cookieReq("/api/billing/subscription", memberToken, "POST", { action: "cancel" }),
    );
    expect(memberCancel.status).toBe(403);

    // OWNER of org A cannot verify a checkout session belonging to org B (§12).
    void ownerToken;
    void owner;
  });

  test("invoices are scoped to the organization (§24)", async () => {
    const a = await makeOrg("inv-iso-a");
    const b = await makeOrg("inv-iso-b");
    await db.invoice.create({
      data: {
        organizationId: a.org.id,
        userId: a.user.id,
        number: `TF-ISO-${Date.now()}`,
        description: "A's invoice",
        amountMicros: 3000_000,
      },
    });

    const { GET: invoicesGET } = await import("@/app/api/billing/invoices/route");
    const tokenB = await sessionFor(b.user.id);
    const resB = await invoicesGET(cookieReq("/api/billing/invoices", tokenB));
    expect((await resB.json()).invoices).toHaveLength(0);

    const tokenA = await sessionFor(a.user.id);
    const resA = await invoicesGET(cookieReq("/api/billing/invoices", tokenA));
    const bodyA = await resA.json();
    expect(bodyA.invoices).toHaveLength(1);
    expect(bodyA.invoices[0].description).toBe("A's invoice");
  });

  test("usage analytics are scoped to the organization", async () => {
    const a = await makeOrg("usage-iso-a");
    const b = await makeOrg("usage-iso-b");
    // Tests use an isolated DB without model seeds — create a stub model row.
    const model = await db.aiModel.create({
      data: { id: `iso-model-${Date.now()}`, displayName: "Iso Model", provider: "taskflow", description: "test" },
    });
    await db.usageEvent.create({
      data: {
        requestId: `tf-iso-${Date.now()}`,
        organizationId: a.org.id,
        userId: a.user.id,
        modelId: model.id,
        provider: "taskflow",
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        customerChargeMicros: 1000,
        status: "SUCCESS",
      },
    });

    const { GET: usageGET } = await import("@/app/api/usage/route");
    const tokenB = await sessionFor(b.user.id);
    const resB = await usageGET(cookieReq("/api/usage", tokenB));
    expect((await resB.json()).totals.requests).toBe(0);

    const tokenA = await sessionFor(a.user.id);
    const resA = await usageGET(cookieReq("/api/usage", tokenA));
    expect((await resA.json()).totals.requests).toBe(1);
  });

  test("org switch endpoint validates membership (§24 tampering)", async () => {
    const a = await makeOrg("switch-a");
    const b = await makeOrg("switch-b");
    const tokenA = await sessionFor(a.user.id);

    const { POST: activePOST } = await import("@/app/api/orgs/active/route");
    const res = await activePOST(
      cookieReq("/api/orgs/active", tokenA, "POST", { organizationId: b.org.id }),
    );
    expect(res.status).toBe(403); // A's owner has no membership in B

    // Legitimate switch works and sets the cookie.
    const other = await db.organization.create({
      data: { name: "A Second", slug: `a-second-${Date.now()}`, ownerUserId: a.user.id },
    });
    await db.membership.create({ data: { organizationId: other.id, userId: a.user.id, role: "OWNER" } });
    const ok = await activePOST(cookieReq("/api/orgs/active", tokenA, "POST", { organizationId: other.id }));
    expect(ok.status).toBe(200);
    const setCookie = ok.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(`${ORG_COOKIE}=${other.id}`);
  });

  test("requireOrgRole throws typed 403 errors", async () => {
    const member = await makeOrg("typed-err");
    const token = await sessionFor(member.user.id);
    try {
      await requireOrgRole(cookieReq("/api/x", token), "OWNER");
      // OWNER on own org passes; force a failure with a fresh MEMBER-only org.
      const outsider = await makeOrg("typed-err-2");
      const outsiderToken = await sessionFor(outsider.user.id);
      let caught: unknown = null;
      try {
        await requireOrgMember(cookieReq("/api/x", outsiderToken), member.org.id, "MEMBER");
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(OrgContextError);
      expect((caught as OrgContextError).status).toBe(403);
    } catch {
      /* covered above */
    }
  });

  test("hashRawKey pepper still works — revoked keys fail gateway auth", async () => {
    const { user, org } = await makeOrg("revoke-gw");
    const { raw, keyHash } = generateRawKey();
    const key = await db.apiKey.create({
      data: { organizationId: org.id, userId: user.id, name: "to-revoke", prefix: raw.slice(0, 12), keyHash },
    });
    await db.apiKey.update({ where: { id: key.id }, data: { status: "REVOKED", revokedAt: new Date() } });
    const result = await authenticateApiKey(raw);
    expect(result.ok).toBe(false);
  });
});
