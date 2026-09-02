/// <reference types="bun-types" />
/**
 * Email/password authentication (Phase 1 §44 scenarios 1–7, 25;
 * correction spec §2, §4, §17):
 *  1. registration creates an UNVERIFIED (PENDING) account with a hashed
 *     password credential + normalized phone — and NO workspace yet
 *  2. duplicate (normalized) email registration is rejected (verified-email
 *     uniqueness, §4)
 *  3. login through the Auth.js Credentials provider
 *  4. invalid password → uniform 401 (no enumeration)
 *  5. logout (session reuse after logout must fail)
 *  6. revoked session rejection
 *  7. expired session rejection
 *  8. authentication rate limiting (§19)
 *  9. /api/auth/me — pending payload before activation, full payload after
 */
import { describe, test, expect, beforeAll } from "bun:test";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { ensureSeedPlans } from "../helpers";
import { POST as registerPOST } from "@/app/api/auth/register/route";
import { POST as loginPOST } from "@/app/api/auth/login/route";
import { GET as meGET } from "@/app/api/auth/me/route";
import { POST as logoutPOST } from "@/app/api/auth/logout/route";
import { createSession, SESSION_COOKIE, sha256 } from "@/server/auth/session";

let ipCounter = 100;
const nextIp = () => `10.10.${Math.floor(ipCounter / 250) % 250}.${ipCounter++ % 250}`;

function jsonRequest(url: string, method: string, body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest(`http://localhost:3000${url}`, {
    method,
    headers: { "content-type": "application/json", "x-forwarded-for": nextIp(), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** Extract the session raw token from a Set-Cookie header. */
function sessionTokenFrom(res: Response): string {
  const setCookie = res.headers.get("set-cookie") ?? "";
  const match = setCookie.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`));
  if (!match) throw new Error(`no session cookie in response: ${setCookie}`);
  return decodeURIComponent(match[1]);
}

function requestWithCookie(url: string, cookie: string) {
  return new NextRequest(`http://localhost:3000${url}`, {
    method: "GET",
    headers: { cookie: `${SESSION_COOKIE}=${cookie}`, "x-forwarded-for": nextIp() },
  });
}

let phoneCounter = 100;
const nextPhone = () => `+44770090${(phoneCounter++).toString().padStart(4, "0")}`;

async function registerWith(email: string, password: string, phone: string = nextPhone()) {
  return registerPOST(jsonRequest("/api/auth/register", "POST", { email, password, phone }));
}

/** Activate an account through the REAL verification services. */
async function activate(userEmail: string, phone?: string): Promise<void> {
  const user = await db.user.findUnique({ where: { email: userEmail } });
  if (!user) throw new Error("user missing");
  const targetPhone = phone ?? user.phone ?? nextPhone();
  if (!user.emailVerifiedAt) {
    await db.user.update({ where: { id: user.id }, data: { emailVerifiedAt: new Date() } });
  }
  const { issuePhoneChallenge } = await import("@/server/auth/phone");
  await issuePhoneChallenge(user.id, targetPhone);
  const sms = await db.smsMessage.findFirst({ where: { to: targetPhone }, orderBy: { createdAt: "desc" } });
  const code = sms!.body.match(/\b(\d{6})\b/)![1];
  const { consumePhoneChallenge, markPhoneVerified } = await import("@/server/auth/phone");
  const consumed = await consumePhoneChallenge(user.id, code);
  if (!consumed.ok) throw new Error(`challenge not consumed: ${consumed.reason}`);
  const marked = await markPhoneVerified(user.id, consumed.phone);
  if (!marked.ok) throw new Error("phone not marked");
  const { activateUserIfEligible } = await import("@/server/tenancy/activation");
  await activateUserIfEligible(user.id);
}

beforeAll(async () => {
  await ensureSeedPlans();
});

describe("email/password authentication", () => {
  test("1. registration creates a PENDING account (no workspace until verification completes, §17)", async () => {
    const email = `reg-${Date.now()}@test-identity.dev`;
    const res = await registerWith(email, "password1");
    expect(res.status).toBe(201);

    const body = await res.json();
    expect(body.user.id).toBeTruthy();
    expect(body.user.status).toBe("PENDING");
    expect(body.emailVerificationSent).toBe(true);
    expect(body.organization).toBeUndefined();

    const user = await db.user.findUnique({ where: { email }, include: { passwordCredential: true } });
    expect(user).not.toBeNull();
    // UUID-style stable identifier, non-sequential (§2)
    expect(user!.id).toMatch(/^[a-z0-9]{20,}$/);
    expect(user!.passwordCredential).not.toBeNull();
    expect(user!.passwordCredential!.passwordHash).toMatch(/^scrypt\$/);
    expect((user as Record<string, unknown>).passwordHash).toBeUndefined(); // no hash on the user row
    expect(user!.phone).toBe("+447700900100");
    expect(user!.phoneVerifiedAt).toBeNull();

    // NO organization before verification (§17).
    expect(await db.organization.count({ where: { ownerUserId: user!.id } })).toBe(0);

    // Session cookie flags
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie.toLowerCase()).toContain("samesite=lax");

    // ── Verification completes → activation provisions the workspace. ──
    await activate(email);
    const org = await db.organization.findFirst({ where: { ownerUserId: user!.id } });
    expect(org).not.toBeNull();
    const membership = await db.membership.findUnique({
      where: { organizationId_userId: { organizationId: org!.id, userId: user!.id } },
    });
    expect(membership?.role).toBe("OWNER");
    const sub = await db.subscription.findUnique({ where: { organizationId: org!.id }, include: { plan: true } });
    expect(sub?.planId).toBe("free");
    const account = await db.creditAccount.findUnique({ where: { organizationId: org!.id } });
    // Free allowance granted at activation through the shared provisioning path.
    expect(account?.balanceMicros).toBe(2_000_000);
  });

  test("2. duplicate (normalized) email registration is rejected (409, §4)", async () => {
    const email = `dup-${Date.now()}@test-identity.dev`;
    const first = await registerWith(email, "password1");
    expect(first.status).toBe(201);
    const second = await registerWith(email, "password2");
    expect(second.status).toBe(409);
    // Normalization: case differences resolve to the SAME account (§4).
    const cased = await registerWith(email.toUpperCase(), "password3");
    expect(cased.status).toBe(409);
  });

  test("3. login (Auth.js credentials) returns a session and updates lastLoginAt", async () => {
    const email = `login-${Date.now()}@test-identity.dev`;
    await registerWith(email, "password1");
    const before = (await db.user.findUnique({ where: { email } }))!.lastLoginAt;

    const res = await loginPOST(jsonRequest("/api/auth/login", "POST", { email, password: "password1" }));
    expect(res.status).toBe(200);
    expect(sessionTokenFrom(res)).toBeTruthy();
    expect((await res.json()).user.status).toBe("PENDING"); // login allowed; gated elsewhere
    const after = (await db.user.findUnique({ where: { email } }))!.lastLoginAt;
    expect(after!.getTime()).toBeGreaterThan((before ?? new Date(0)).getTime() - 1);
  });

  test("4. invalid password → uniform 401 (no enumeration)", async () => {
    const email = `badpw-${Date.now()}@test-identity.dev`;
    await registerWith(email, "password1");
    const res = await loginPOST(jsonRequest("/api/auth/login", "POST", { email, password: "wrongpass1" }));
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("Invalid email or password");
    // Unknown email gets the SAME response (no user enumeration).
    const ghost = await loginPOST(jsonRequest("/api/auth/login", "POST", { email: `ghost-${Date.now()}@x.dev`, password: "whatever1" }));
    expect(ghost.status).toBe(401);
    expect((await ghost.json()).error).toBe("Invalid email or password");
  });

  test("5. logout revokes the session — cookie reuse afterwards fails", async () => {
    const email = `logout-${Date.now()}@test-identity.dev`;
    const reg = await registerWith(email, "password1");
    const token = sessionTokenFrom(reg);

    const me1 = await meGET(requestWithCookie("/api/auth/me", token));
    expect(me1.status).toBe(200);

    const logoutRes = await logoutPOST(
      new NextRequest("http://localhost:3000/api/auth/logout", {
        method: "POST",
        headers: { cookie: `${SESSION_COOKIE}=${token}` },
        body: JSON.stringify({}),
      }),
    );
    expect(logoutRes.status).toBe(200);

    const me2 = await meGET(requestWithCookie("/api/auth/me", token));
    expect(me2.status).toBe(401); // session reuse after logout must fail (§33)
    const row = await db.session.findUnique({ where: { tokenHash: sha256(token) } });
    expect(row?.revokedAt).not.toBeNull(); // revoked, not deleted (audit)
  });

  test("6. explicitly revoked session is rejected", async () => {
    const email = `revoke-${Date.now()}@test-identity.dev`;
    const reg = await registerWith(email, "password1");
    const token = sessionTokenFrom(reg);
    await db.session.update({ where: { tokenHash: sha256(token) }, data: { revokedAt: new Date() } });
    const meRes = await meGET(requestWithCookie("/api/auth/me", token));
    expect(meRes.status).toBe(401);
  });

  test("7. expired session is rejected", async () => {
    const email = `expired-${Date.now()}@test-identity.dev`;
    const reg = await registerWith(email, "password1");
    const token = sessionTokenFrom(reg);
    await db.session.update({
      where: { tokenHash: sha256(token) },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const meRes = await meGET(requestWithCookie("/api/auth/me", token));
    expect(meRes.status).toBe(401);
  });

  test("8. login rate limiting kicks in (per IP+email)", async () => {
    const email = `ratelimit-${Date.now()}@test-identity.dev`;
    const ip = nextIp();
    // 8 allowed attempts (limit), 9th is throttled.
    let last = 0;
    for (let i = 0; i < 9; i++) {
      const res = await loginPOST(jsonRequest("/api/auth/login", "POST", { email, password: "wrongpass1" }, { "x-forwarded-for": ip }));
      last = res.status;
    }
    expect(last).toBe(429);
  });

  test("9. /api/auth/me — pending payload before activation, full payload after", async () => {
    const email = `me-${Date.now()}@test-identity.dev`;
    const reg = await registerWith(email, "password1");
    const token = sessionTokenFrom(reg);

    // PENDING: identity + verification state only — NO organization data.
    const pendingRes = await meGET(requestWithCookie("/api/auth/me", token));
    const pendingBody = await pendingRes.json();
    expect(pendingBody.user.email).toBe(email);
    expect(pendingBody.pending).toBe(true);
    expect(pendingBody.user.emailVerified).toBe(false);
    expect(pendingBody.user.phoneVerified).toBe(false);
    expect(pendingBody.organization).toBeNull();
    expect(pendingBody.organizations).toHaveLength(0);
    expect(pendingBody.role).toBeNull();
    expect(Array.isArray(pendingBody.providers)).toBe(true);
    // No secret material leaks through the bootstrap payload (§43).
    expect(JSON.stringify(pendingBody)).not.toContain("passwordHash");
    expect(JSON.stringify(pendingBody)).not.toContain("tokenHash");

    // ACTIVE after verification: full dashboard payload.
    await activate(email);
    const activeRes = await meGET(requestWithCookie("/api/auth/me", token));
    const activeBody = await activeRes.json();
    expect(activeBody.pending).toBeUndefined();
    expect(activeBody.user.status).toBe("ACTIVE");
    expect(activeBody.user.phoneVerified).toBe(true);
    expect(activeBody.role).toBe("OWNER");
    expect(activeBody.organization.isPersonal).toBe(true);
    expect(activeBody.organizations).toHaveLength(1);
  });
});
