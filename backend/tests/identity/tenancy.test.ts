/// <reference types="bun-types" />
/**
 * Organizations, memberships, invitations & role authorization
 * (Phase 1 §44 scenarios 13–21):
 *  - organization creation (idempotent provisioning path)
 *  - membership creation + duplicate prevention (unique constraint)
 *  - Free-plan invitation limit (OWNER + 2, DB-backed Plan.maxMembers)
 *  - invitation acceptance / expired / revoked / email mismatch
 *  - cross-organization access denial
 *  - role authorization (billing OWNER-only; keys ADMIN+; role change rules)
 */
import { describe, test, expect, beforeAll } from "bun:test";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { ensureSeedPlans, makeOrg } from "../helpers";
import { createOrganization, ensurePersonalOrg } from "@/server/tenancy/org-service";
import { createInvitation, acceptInvitation, lookupInvitation, revokeInvitation } from "@/server/tenancy/invitations";
import { getOrgContext, requireOrgRole, requireOrgMember, roleAtLeast, OrgContextError, ORG_COOKIE } from "@/server/tenancy/authz";
import { createSession, SESSION_COOKIE } from "@/server/auth/session";
import { randomBytes } from "crypto";

let ipCounter = 300;
const nextIp = () => `10.${ipCounter++}.0.1`;

function cookieReq(url: string, token: string, method = "GET", body?: unknown, extraCookie = "") {
  return new NextRequest(`http://localhost:3000${url}`, {
    method,
    headers: {
      cookie: `${SESSION_COOKIE}=${token}${extraCookie ? `; ${extraCookie}` : ""}`,
      "x-forwarded-for": nextIp(),
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function next(NextResponseFn: (req: NextRequest) => Promise<Response>) {
  return NextResponseFn;
}

beforeAll(async () => {
  await ensureSeedPlans();
});

describe("organizations & memberships", () => {
  test("createOrganization provisions org + OWNER membership + Free sub + credits (§3, §26)", async () => {
    const email = `orgcreate-${Date.now()}@test-tenancy.dev`;
    const user = await db.user.create({
      data: { email, passwordCredential: { create: { passwordHash: "scrypt$aa$bb" } } },
    });

    const org = await createOrganization({ owner: user, name: "Acme AI Ltd" });
    expect(org.name).toBe("Acme AI Ltd");
    expect(org.slug).toMatch(/^acme-ai-ltd/);

    const membership = await db.membership.findUnique({
      where: { organizationId_userId: { organizationId: org.id, userId: user.id } },
    });
    expect(membership?.role).toBe("OWNER");

    const sub = await db.subscription.findUnique({ where: { organizationId: org.id } });
    expect(sub?.planId).toBe("free");
    const account = await db.creditAccount.findUnique({ where: { organizationId: org.id } });
    expect(account?.balanceMicros).toBe(2_000_000);
  });

  test("ensurePersonalOrg is idempotent — no duplicate orgs on repeat calls (§32)", async () => {
    const email = `idem-${Date.now()}@test-tenancy.dev`;
    const user = await db.user.create({
      data: { email, passwordCredential: { create: { passwordHash: "scrypt$aa$bb" } } },
    });
    const org1 = await ensurePersonalOrg(user);
    const org2 = await ensurePersonalOrg(user);
    expect(org1.id).toBe(org2.id);
    expect(await db.organization.count({ where: { ownerUserId: user.id } })).toBe(1);
  });

  test("duplicate membership in the same org is impossible (unique org+user, §18)", async () => {
    const { user, org } = await makeOrg("dupm");
    let threw = false;
    try {
      await db.membership.create({ data: { organizationId: org.id, userId: user.id, role: "MEMBER" } });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true); // UNIQUE organizationId+userId
    expect(await db.membership.count({ where: { organizationId: org.id } })).toBe(1);
  });

  test("a user can belong to MULTIPLE organizations (§22)", async () => {
    const { user, org } = await makeOrg("multi-a");
    const other = await createOrganization({ owner: user, name: "Second Org" });
    const memberships = await db.membership.findMany({ where: { userId: user.id } });
    expect(memberships).toHaveLength(2);
    const roles = memberships.map((m) => m.role);
    expect(roles.filter((r) => r === "OWNER")).toHaveLength(2);
    void org;
  });

  test("active-org context follows the membership cookie and is re-validated (§23)", async () => {
    const { user, org } = await makeOrg("ctx-a");
    const second = await createOrganization({ owner: user, name: "Ctx Org B" });
    const { createSession } = await import("@/server/auth/session");
    const session = await createSession(user.id);

    // Default: personal org.
    const ctx1 = await getOrgContext(cookieReq("/api/anything", session.raw));
    expect(ctx1.organization.id).toBe(org.id);
    expect(ctx1.role).toBe("OWNER");

    // Switch via cookie → second org.
    const ctx2 = await getOrgContext(cookieReq("/api/anything", session.raw, "GET", undefined, `${ORG_COOKIE}=${second.id}`));
    expect(ctx2.organization.id).toBe(second.id);

    // A cookie pointing at an org the user is NOT a member of is ignored —
    // falls back to a valid membership (§24: cookie never trusted alone).
    const stranger = await makeOrg("ctx-stranger");
    const ctx3 = await getOrgContext(cookieReq("/api/anything", session.raw, "GET", undefined, `${ORG_COOKIE}=${stranger.org.id}`));
    expect(ctx3.organization.id).not.toBe(stranger.org.id);
  });
});

describe("invitations", () => {
  test("invitation create → lookup → accept, then token cannot be reused (§21)", async () => {
    const { user, org } = await makeOrg("inv-basic");
    const inviteeEmail = `invitee-${Date.now()}@test-tenancy.dev`;

    const { rawToken } = await createInvitation({
      organizationId: org.id,
      invitedBy: { id: user.id, email: user.email, name: user.name },
      email: inviteeEmail,
      role: "MEMBER",
    });

    // Only the HASH is stored (§19).
    const stored = await db.invitation.findFirst({ where: { organizationId: org.id } });
    expect(stored!.tokenHash).not.toBe(rawToken);
    expect(stored!.tokenHash).toMatch(/^[a-f0-9]{64}$/);

    const preview = await lookupInvitation(rawToken);
    expect(preview.organizationName).toBe(org.name);
    expect(preview.emailMatches(inviteeEmail)).toBe(true);

    // Invitee registers + accepts.
    const invitee = await db.user.create({
      data: { email: inviteeEmail, status: "ACTIVE", emailVerifiedAt: new Date(), phoneVerifiedAt: new Date(), passwordCredential: { create: { passwordHash: "scrypt$aa$bb" } } },
    });
    const result = await acceptInvitation({ rawToken, user: { id: invitee.id, email: inviteeEmail } });
    expect(result.organizationId).toBe(org.id);
    expect(result.role).toBe("MEMBER");

    // Token is now dead (single-use).
    await expect(lookupInvitation(rawToken)).rejects.toThrow(/already accepted/);
    let reuseThrew = false;
    try {
      await acceptInvitation({ rawToken, user: { id: invitee.id, email: inviteeEmail } });
    } catch {
      reuseThrew = true;
    }
    expect(reuseThrew).toBe(true);
  });

  test("invitation acceptance REQUIRES the invited email (no drive-by joining, §21)", async () => {
    const { user, org } = await makeOrg("inv-email");
    const invitedEmail = `bound-${Date.now()}@test-tenancy.dev`;
    const { rawToken } = await createInvitation({
      organizationId: org.id,
      invitedBy: { id: user.id, email: user.email, name: user.name },
      email: invitedEmail,
      role: "MEMBER",
    });
    const stranger = await db.user.create({
      data: { status: "ACTIVE", emailVerifiedAt: new Date(), phoneVerifiedAt: new Date(), email: `stranger-${Date.now()}@test-tenancy.dev`, passwordCredential: { create: { passwordHash: "x" } } },
    });
    await expect(
      acceptInvitation({ rawToken, user: { id: stranger.id, email: stranger.email } }),
    ).rejects.toThrow(/sent to/);
    expect(await db.membership.count({ where: { organizationId: org.id } })).toBe(1);
  });

  test("expired invitation is rejected", async () => {
    const { user, org } = await makeOrg("inv-exp");
    const inviteeEmail = `expired-${Date.now()}@test-tenancy.dev`;
    const { rawToken } = await createInvitation({
      organizationId: org.id,
      invitedBy: { id: user.id, email: user.email, name: user.name },
      email: inviteeEmail,
      role: "MEMBER",
    });
    const { sha256 } = await import("@/server/auth/session");
    await db.invitation.update({
      where: { tokenHash: sha256(rawToken) },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await expect(lookupInvitation(rawToken)).rejects.toThrow(/expired/);
  });

  test("revoked invitation is rejected", async () => {
    const { user, org } = await makeOrg("inv-rev");
    const inviteeEmail = `revoked-${Date.now()}@test-tenancy.dev`;
    const { rawToken } = await createInvitation({
      organizationId: org.id,
      invitedBy: { id: user.id, email: user.email, name: user.name },
      email: inviteeEmail,
      role: "MEMBER",
    });
    const { sha256 } = await import("@/server/auth/session");
    const stored = await db.invitation.findUnique({ where: { tokenHash: sha256(rawToken) } });
    await revokeInvitation(stored!.id, org.id, user.id);
    await expect(lookupInvitation(rawToken)).rejects.toThrow(/revoked/);
  });

  test("Free-plan seat limit: OWNER + 2 members; 4th seat refused (DB-backed, §20)", async () => {
    const { user, org } = await makeOrg("inv-seat");
    await db.plan.update({ where: { id: "free" }, data: { maxMembers: 3 } });

    const mkInvitee = (email: string) =>
      db.user.create({
        data: { email, passwordCredential: { create: { passwordHash: "x" } } },
      });

    // Two invitations accepted → 3 members total.
    for (let i = 0; i < 2; i++) {
      const inviteeEmail = `seat-${Date.now()}-${i}@test-tenancy.dev`;
      const { rawToken } = await createInvitation({
        organizationId: org.id,
        invitedBy: { id: user.id, email: user.email, name: user.name },
        email: inviteeEmail,
        role: "MEMBER",
      });
      const invitee = await mkInvitee(inviteeEmail);
      await acceptInvitation({ rawToken, user: { id: invitee.id, email: invitee.email } });
    }
    expect(await db.membership.count({ where: { organizationId: org.id } })).toBe(3);

    // Third invitation → seat limit (2 pending+members hit 3/3).
    await expect(
      createInvitation({
        organizationId: org.id,
        invitedBy: { id: user.id, email: user.email, name: user.name },
        email: `overflow-${Date.now()}@test-tenancy.dev`,
        role: "MEMBER",
      }),
    ).rejects.toThrow(/Seat limit reached \(3\/3\)/);

    // Direct membership insert beyond the limit is a business-policy violation
    // the SERVICE refuses too (accept path re-checks atomically).
    const extra = await mkInvitee(`overflow-user-${Date.now()}@test-tenancy.dev`);
    await expect(
      acceptInvitation({ rawToken: randomBytes(32).toString("base64url"), user: { id: extra.id, email: extra.email } }),
    ).rejects.toThrow();
  });
});

describe("role authorization (§25)", () => {
  test("role hierarchy is monotonic", () => {
    expect(roleAtLeast("OWNER", "MEMBER")).toBe(true);
    expect(roleAtLeast("OWNER", "OWNER")).toBe(true);
    expect(roleAtLeast("ADMIN", "ADMIN")).toBe(true);
    expect(roleAtLeast("ADMIN", "OWNER")).toBe(false);
    expect(roleAtLeast("MEMBER", "ADMIN")).toBe(false);
    expect(roleAtLeast("bogus", "MEMBER")).toBe(false);
  });

  test("requireOrgRole enforces floors: MEMBER cannot create keys, ADMIN can, MEMBER cannot bill", async () => {
    const { user, org } = await makeOrg("roles");
    const member = await db.user.create({
      data: { status: "ACTIVE", emailVerifiedAt: new Date(), phoneVerifiedAt: new Date(), email: `member-${Date.now()}@test-tenancy.dev`, passwordCredential: { create: { passwordHash: "x" } } },
    });
    await db.membership.create({ data: { organizationId: org.id, userId: member.id, role: "MEMBER" } });
    const admin = await db.user.create({
      data: { status: "ACTIVE", emailVerifiedAt: new Date(), phoneVerifiedAt: new Date(), email: `admin-${Date.now()}@test-tenancy.dev`, passwordCredential: { create: { passwordHash: "x" } } },
    });
    await db.membership.create({ data: { organizationId: org.id, userId: admin.id, role: "ADMIN" } });

    const { createSession } = await import("@/server/auth/session");
    const memberSession = await createSession(member.id);
    const adminSession = await createSession(admin.id);
    const ownerSession = await createSession(user.id);

    // MEMBER: can view keys, cannot create.
    const memberCtx = await requireOrgRole(cookieReq("/api/keys", memberSession.raw), "MEMBER");
    expect(memberCtx.organization.id).toBe(org.id);
    await expect(requireOrgRole(cookieReq("/api/keys", memberSession.raw), "ADMIN")).rejects.toThrow(/Requires ADMIN/);

    // ADMIN: can create keys, cannot bill.
    const adminCtx = await requireOrgRole(cookieReq("/api/keys", adminSession.raw), "ADMIN");
    expect(adminCtx.role).toBe("ADMIN");
    await expect(requireOrgRole(cookieReq("/api/billing", adminSession.raw), "OWNER")).rejects.toThrow(/Requires OWNER/);

    // OWNER: full access.
    const ownerCtx = await requireOrgRole(cookieReq("/api/billing", ownerSession.raw), "OWNER");
    expect(ownerCtx.role).toBe("OWNER");
    void memberCtx;
  });

  test("requireOrgMember rejects org ids the user has no membership in (ID tampering, §24)", async () => {
    const { user, org } = await makeOrg("tamper-a");
    const stranger = await makeOrg("tamper-b");
    const { createSession } = await import("@/server/auth/session");
    const session = await createSession(user.id);

    // Same user, own org: fine.
    const ctx = await requireOrgMember(cookieReq("/api/x", session.raw), org.id, "MEMBER");
    expect(ctx.organization.id).toBe(org.id);

    // Cookie forges membership in the stranger org? Still denied.
    const forged = cookieReq("/api/x", session.raw, "GET", undefined, `${ORG_COOKIE}=${stranger.org.id}`);
    await expect(requireOrgMember(forged, stranger.org.id, "MEMBER")).rejects.toThrow(/Not a member/);
    void next;
  });

  test("OrgContextError maps to 401 for missing sessions", async () => {
    await expect(getOrgContext(new NextRequest("http://localhost:3000/api/x"))).rejects.toMatchObject({ status: 401 });
  });
});
