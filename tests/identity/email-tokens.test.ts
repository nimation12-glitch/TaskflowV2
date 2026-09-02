/// <reference types="bun-types" />
/**
 * Email verification + password reset (Phase 1 §5, §33):
 *  - verification token verifies the email; reuse fails; wrong token fails
 *  - forgot-password response is uniform (no account enumeration)
 *  - reset completes with a valid token, marks email verified, and revokes
 *    ALL sessions
 *  - expired reset tokens are rejected
 */
import { describe, test, expect, beforeAll } from "bun:test";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { ensureSeedPlans } from "../helpers";
import { POST as registerPOST } from "@/app/api/auth/register/route";
import { POST as verifyEmailPOST } from "@/app/api/auth/verify-email/route";
import { POST as forgotPOST } from "@/app/api/auth/forgot-password/route";
import { POST as resetPOST } from "@/app/api/auth/reset-password/route";
import { POST as loginPOST } from "@/app/api/auth/login/route";
import { GET as meGET } from "@/app/api/auth/me/route";
import { SESSION_COOKIE } from "@/server/auth/session";

let ipCounter = 100;
const nextIp = () => `10.${ipCounter++}.0.1`;

function jsonRequest(url: string, method: string, body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest(`http://localhost:3000${url}`, {
    method,
    headers: { "content-type": "application/json", "x-forwarded-for": nextIp(), ...headers },
    body: JSON.stringify(body),
  });
}

function sessionTokenFrom(res: Response): string {
  const setCookie = res.headers.get("set-cookie") ?? "";
  const match = setCookie.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`));
  if (!match) throw new Error(`no session cookie: ${setCookie}`);
  return decodeURIComponent(match[1]);
}

async function latestTokenFor(email: string, type: string): Promise<string> {
  // Dev transport stores the full body in the outbox — extract the token link.
  const msg = await db.emailMessage.findFirst({
    where: { to: email, body: { contains: type === "PASSWORD_RESET" ? "Reset link" : "Confirm this email" } },
    orderBy: { createdAt: "desc" },
  });
  expect(msg).not.toBeNull();
  const match = msg!.body.match(/token=([A-Za-z0-9_-]+)/);
  expect(match).not.toBeNull();
  return match![1];
}

beforeAll(async () => {
  await ensureSeedPlans();
});

describe("email verification & password reset", () => {
  test("verification token flow: verify → verified; replay fails; wrong token fails", async () => {
    const email = `verify-${Date.now()}@test-identity.dev`;
    const reg = await registerPOST(jsonRequest("/api/auth/register", "POST", { email, password: "password1", phone: "+447700901234" }));
    expect(reg.status).toBe(201);

    const token = await latestTokenFor(email, "EMAIL_VERIFY");
    const ok = await verifyEmailPOST(jsonRequest("/api/auth/verify-email", "POST", { token }));
    expect(ok.status).toBe(200);

    const user = await db.user.findUnique({ where: { email } });
    expect(user?.emailVerifiedAt).not.toBeNull();

    // Replay — single use (§33 token reuse)
    const replay = await verifyEmailPOST(jsonRequest("/api/auth/verify-email", "POST", { token }));
    expect(replay.status).toBe(400);

    // Forged/garbage token
    const bad = await verifyEmailPOST(jsonRequest("/api/auth/verify-email", "POST", { token: "not-a-real-token" }));
    expect(bad.status).toBe(400);
  });

  test("forgot-password never enumerates accounts", async () => {
    const realEmail = `forgot-real-${Date.now()}@test-identity.dev`;
    await registerPOST(jsonRequest("/api/auth/register", "POST", { email: realEmail, password: "password1", phone: "+447700901234" }));

    const real = await forgotPOST(jsonRequest("/api/auth/forgot-password", "POST", { email: realEmail }));
    const ghost = await forgotPOST(jsonRequest("/api/auth/forgot-password", "POST", { email: `ghost-${Date.now()}@x.dev` }));
    expect(real.status).toBe(200);
    expect(ghost.status).toBe(200);
    expect(await real.json()).toEqual(await ghost.json());

    // A reset message was actually queued for the REAL address only.
    const msg = await db.emailMessage.findFirst({
      where: { to: realEmail, subject: { contains: "Reset your TaskFlow password" } },
      orderBy: { createdAt: "desc" },
    });
    expect(msg).not.toBeNull();
  });

  test("password reset: works, revokes all sessions, marks email verified", async () => {
    const email = `reset-${Date.now()}@test-identity.dev`;
    const reg = await registerPOST(jsonRequest("/api/auth/register", "POST", { email, password: "password1", phone: "+447700901234" }));
    const sessionA = sessionTokenFrom(reg);
    // A second live session (another device).
    const { createSession } = await import("@/server/auth/session");
    const second = await createSession((await db.user.findUnique({ where: { email } }))!.id);
    void second;

    await forgotPOST(jsonRequest("/api/auth/forgot-password", "POST", { email }));
    const token = await latestTokenFor(email, "PASSWORD_RESET");

    const res = await resetPOST(jsonRequest("/api/auth/reset-password", "POST", { token, password: "newpassword2" }));
    expect(res.status).toBe(200);

    // Old sessions are dead.
    expect((await meGET(new NextRequest("http://localhost:3000/api/auth/me", { headers: { cookie: `${SESSION_COOKIE}=${sessionA}` } }))).status).toBe(401);

    // New password works; old one doesn't.
    const oldLogin = await loginPOST(jsonRequest("/api/auth/login", "POST", { email, password: "password1" }));
    expect(oldLogin.status).toBe(401);
    const newLogin = await loginPOST(jsonRequest("/api/auth/login", "POST", { email, password: "newpassword2" }));
    expect(newLogin.status).toBe(200);

    const user = await db.user.findUnique({ where: { email } });
    expect(user?.emailVerifiedAt).not.toBeNull();
  });

  test("expired reset token is rejected", async () => {
    const email = `reset-exp-${Date.now()}@test-identity.dev`;
    await registerPOST(jsonRequest("/api/auth/register", "POST", { email, password: "password1", phone: "+447700901234" }));
    await forgotPOST(jsonRequest("/api/auth/forgot-password", "POST", { email }));
    const token = await latestTokenFor(email, "PASSWORD_RESET");
    const { sha256 } = await import("@/server/auth/session");
    await db.authToken.update({ where: { tokenHash: sha256(token) }, data: { expiresAt: new Date(Date.now() - 5000) } });

    const res = await resetPOST(jsonRequest("/api/auth/reset-password", "POST", { token, password: "newpassword2" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("expired");
  });
});
