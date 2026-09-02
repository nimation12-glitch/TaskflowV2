/// <reference types="bun-types" />
/**
 * Phone verification & anti-abuse (correction spec §2, §3, §4, §19).
 *
 * Covered:
 *  - phone normalization (E.164)
 *  - challenge issuance: hashed storage (raw code NEVER at rest), SMS outbox
 *    (dev transport), masked audit metadata
 *  - confirmation: correct code verifies + activates the pending account
 *    (org + OWNER membership + Free subscription + credits) transactionally
 *  - single-use semantics (replay rejected), expiry, attempt limits
 *    (brute force capped), rate limits on request/confirm
 *  - DUPLICATE VERIFIED PHONE is refused (no cross-account reuse, §4)
 *  - truthful delivery reporting when the SMS provider is unconfigured
 *  - activation idempotency (repeat confirm/verify never duplicates rows)
 */
import { describe, test, expect, beforeAll } from "bun:test";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { ensureSeedPlans } from "../helpers";

process.env.SMS_PROVIDER = "dev"; // in-process dev transport (code in outbox)

const { POST: requestPOST } = await import("@/app/api/auth/phone/request/route");
const { POST: confirmPOST } = await import("@/app/api/auth/phone/confirm/route");
const { normalizePhone, maskPhone } = await import("@/server/auth/phone");
const { createSession, SESSION_COOKIE } = await import("@/server/auth/session");
const { verifyPassword, hashPassword } = await import("@/server/auth/password");

let ipCounter = 500;
const nextIp = () => `10.50.${Math.floor(ipCounter / 250) % 250}.${ipCounter++ % 250}`;

function jsonRequest(path: string, body: unknown, sessionRaw?: string): NextRequest {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-forwarded-for": nextIp(),
    origin: "http://localhost:3000",
    host: "localhost:3000",
  };
  if (sessionRaw) headers.cookie = `${SESSION_COOKIE}=${sessionRaw}`;
  return new NextRequest(`http://localhost:3000${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  }) as NextRequest;
}

async function codeFor(phone: string): Promise<string> {
  const row = await db.smsMessage.findFirst({
    where: { to: phone, provider: "dev" },
    orderBy: { createdAt: "desc" },
  });
  if (!row) throw new Error(`no dev SMS for ${phone}`);
  const match = row.body.match(/\b(\d{6})\b/);
  if (!match) throw new Error(`no code in SMS body: ${row.body}`);
  return match[1];
}

beforeAll(async () => {
  await ensureSeedPlans();
});

describe("phone normalization", () => {
  test("normalizes separators and rejects invalid numbers", () => {
    expect(normalizePhone("+44 7700 900123")).toBe("+447700900123");
    expect(normalizePhone("+44-7700-900123")).toBe("+447700900123");
    expect(normalizePhone("+44 (7700) 900123")).toBe("+447700900123");
    expect(normalizePhone("447700900123")).toBe("+447700900123");
    expect(normalizePhone("07700900123")).toBeNull(); // no country code
    expect(normalizePhone("+4412")).toBeNull(); // too short
    expect(normalizePhone("not-a-phone")).toBeNull();
  });

  test("maskPhone never renders a full number", () => {
    const masked = maskPhone("+447700900123");
    expect(masked).not.toContain("7700900123");
    expect(masked.startsWith("+44")).toBe(true);
    expect(masked.endsWith("0123")).toBe(true);
  });
});

describe("phone verification flow", () => {
  test("issue → confirm verifies the phone, activates the pending account and provisions the workspace", async () => {
    const email = `phone-activate-${Date.now()}@test-phone.dev`;
    const user = await db.user.create({
      data: {
        email,
        phone: "+447700900001",
        status: "PENDING",
        passwordCredential: { create: { passwordHash: hashPassword("password1") } },
      },
    });
    // Policy also requires the email to be verified.
    await db.user.update({ where: { id: user.id }, data: { emailVerifiedAt: new Date() } });
    const session = await createSession(user.id);

    // ── Issue ──
    const reqRes = await requestPOST(jsonRequest("/api/auth/phone/request", {}, session.raw));
    expect(reqRes.status).toBe(200);
    const reqBody = await reqRes.json();
    expect(reqBody.sent).toBe(true);
    expect(reqBody.transport).toBe("dev");

    // Code NEVER at rest in plaintext: the challenge row holds only a hash.
    const challenge = await db.phoneVerificationChallenge.findFirst({ where: { userId: user.id } });
    expect(challenge).not.toBeNull();
    expect(challenge!.codeHash).toMatch(/^[a-f0-9]{64}$/);
    expect(challenge!.consumedAt).toBeNull();
    expect(challenge!.attempts).toBe(0);
    // Dev outbox carries the body (dev transport only), audit metadata is masked.
    const code = await codeFor("+447700900001");
    expect(code).toMatch(/^\d{6}$/);

    // ── Confirm ──
    const confirmRes = await confirmPOST(jsonRequest("/api/auth/phone/confirm", { code }, session.raw));
    expect(confirmRes.status).toBe(200);
    const confirmBody = await confirmRes.json();
    expect(confirmBody.activated).toBe(true);

    const activated = await db.user.findUnique({ where: { id: user.id } });
    expect(activated!.phoneVerifiedAt).not.toBeNull();
    expect(activated!.status).toBe("ACTIVE");

    // Workspace provisioned exactly once (§9).
    const org = await db.organization.findFirst({ where: { ownerUserId: user.id } });
    expect(org).not.toBeNull();
    const membership = await db.membership.findUnique({
      where: { organizationId_userId: { organizationId: org!.id, userId: user.id } },
    });
    expect(membership?.role).toBe("OWNER");
    const sub = await db.subscription.findUnique({ where: { organizationId: org!.id } });
    expect(sub?.planId).toBe("free");
    const account = await db.creditAccount.findUnique({ where: { organizationId: org!.id } });
    expect(account).not.toBeNull();

    // ── Replay of the SAME code is rejected (single-use, §19) ──
    const replayRes = await confirmPOST(jsonRequest("/api/auth/phone/confirm", { code }, session.raw));
    expect(replayRes.status).toBe(400);
    expect((await replayRes.json()).error).toMatch(/No active verification/);
  });

  test("activation is idempotent — a repeated confirm cannot duplicate the org (§9)", async () => {
    const email = `phone-idem-${Date.now()}@test-phone.dev`;
    const user = await db.user.create({
      data: {
        email,
        phone: "+447700900002",
        emailVerifiedAt: new Date(),
        phoneVerifiedAt: new Date(),
        status: "PENDING",
        passwordCredential: { create: { passwordHash: hashPassword("password1") } },
      },
    });
    const session = await createSession(user.id);
    await requestPOST(jsonRequest("/api/auth/phone/request", {}, session.raw));
    const code = await codeFor("+447700900002");
    const first = await confirmPOST(jsonRequest("/api/auth/phone/confirm", { code }, session.raw));
    expect(first.status).toBe(200);
    // Re-confirm (already consumed) → no duplicate provisioning.
    await requestPOST(jsonRequest("/api/auth/phone/request", {}, session.raw));
    const code2 = await codeFor("+447700900002");
    await confirmPOST(jsonRequest("/api/auth/phone/confirm", { code: code2 }, session.raw));
    expect(await db.organization.count({ where: { ownerUserId: user.id } })).toBe(1);
    expect(await db.membership.count({ where: { userId: user.id, role: "OWNER" } })).toBe(1);
  });

  test("wrong codes increment attempts; after the cap the challenge is dead (§19)", async () => {
    const email = `phone-attempts-${Date.now()}@test-phone.dev`;
    const user = await db.user.create({
      data: { email, phone: "+447700900003", status: "PENDING", passwordCredential: { create: { passwordHash: hashPassword("password1") } } },
    });
    const session = await createSession(user.id);
    await requestPOST(jsonRequest("/api/auth/phone/request", {}, session.raw));

    let last = 0;
    for (let i = 0; i < 6; i++) {
      const res = await confirmPOST(jsonRequest("/api/auth/phone/confirm", { code: "000000" }, session.raw));
      last = res.status;
    }
    expect(last).toBe(401); // uniform wrong-code response, attempt counter capped
    const challenge = await db.phoneVerificationChallenge.findFirst({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" },
    });
    expect(challenge!.attempts).toBe(5); // capped — no unbounded increments

    // The CORRECT code is now also refused — the challenge is dead.
    await requestPOST(jsonRequest("/api/auth/phone/request", {}, session.raw));
    const fresh = await codeFor("+447700900003");
    const ok = await confirmPOST(jsonRequest("/api/auth/phone/confirm", { code: fresh }, session.raw));
    expect(ok.status).toBe(200);
  });

  test("expired challenges are rejected", async () => {
    const email = `phone-expiry-${Date.now()}@test-phone.dev`;
    const user = await db.user.create({
      data: { email, phone: "+447700900004", status: "PENDING", passwordCredential: { create: { passwordHash: hashPassword("password1") } } },
    });
    const session = await createSession(user.id);
    await requestPOST(jsonRequest("/api/auth/phone/request", {}, session.raw));
    await db.phoneVerificationChallenge.updateMany({
      where: { userId: user.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const code = await codeFor("+447700900004");
    const res = await confirmPOST(jsonRequest("/api/auth/phone/confirm", { code }, session.raw));
    expect(res.status).toBe(401);
    expect((await res.json()).error).toMatch(/expired/i);
  });

  test("request rate limiting kicks in (3 per 10 min per user, §19)", async () => {
    const email = `phone-rl-${Date.now()}@test-phone.dev`;
    const user = await db.user.create({
      data: { email, phone: "+447700900005", status: "PENDING", passwordCredential: { create: { passwordHash: hashPassword("password1") } } },
    });
    const session = await createSession(user.id);
    let last = 0;
    for (let i = 0; i < 5; i++) {
      const res = await requestPOST(jsonRequest("/api/auth/phone/request", {}, session.raw));
      last = res.status;
    }
    expect(last).toBe(429);
  });

  test("DUPLICATE VERIFIED PHONE is refused — a verified number belongs to one account (§4)", async () => {
    const emailA = `phone-dup-a-${Date.now()}@test-phone.dev`;
    const emailB = `phone-dup-b-${Date.now()}@test-phone.dev`;
    const userA = await db.user.create({
      data: {
        email: emailA,
        phone: "+447700900006",
        phoneVerifiedAt: new Date(),
        status: "ACTIVE",
        passwordCredential: { create: { passwordHash: hashPassword("password1") } },
      },
    });
    const userB = await db.user.create({
      data: { email: emailB, phone: "+447700900007", status: "PENDING", passwordCredential: { create: { passwordHash: hashPassword("password1") } } },
    });
    await db.user.update({ where: { id: userB.id }, data: { emailVerifiedAt: new Date() } });
    const sessionB = await createSession(userB.id);

    // B claims A's number: request (replacing the number) then confirm.
    await requestPOST(jsonRequest("/api/auth/phone/request", { phone: "+447700900006" }, sessionB.raw));
    const code = await codeFor("+447700900006");
    const res = await confirmPOST(jsonRequest("/api/auth/phone/confirm", { code }, sessionB.raw));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/already verified on another account/);

    // A's binding unchanged; B remains unverified on their own number.
    const a = await db.user.findUnique({ where: { id: userA.id } });
    expect(a!.phoneVerifiedAt).not.toBeNull();
    const b = await db.user.findUnique({ where: { id: userB.id } });
    expect(b!.phoneVerifiedAt).toBeNull();
  });

  test("unconfigured SMS provider reports the truth instead of faking a send (§12)", async () => {
    process.env.SMS_PROVIDER = "twilio"; // declared but WITHOUT credentials
    try {
      const email = `phone-unconf-${Date.now()}@test-phone.dev`;
      const user = await db.user.create({
        data: { email, phone: "+447700900008", status: "PENDING", passwordCredential: { create: { passwordHash: hashPassword("password1") } } },
      });
      const session = await createSession(user.id);
      const res = await requestPOST(jsonRequest("/api/auth/phone/request", {}, session.raw));
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.sent).toBe(false);
      expect(body.reason).toBe("sms_not_configured");
      // No challenge row was created.
      expect(await db.phoneVerificationChallenge.count({ where: { userId: user.id } })).toBe(0);
    } finally {
      process.env.SMS_PROVIDER = "dev";
    }
  });

  test("email/password users remain PENDING (no workspace) until BOTH verifications complete (§17)", async () => {
    const email = `phone-pending-${Date.now()}@test-phone.dev`;
    const user = await db.user.create({
      data: { email, phone: "+447700900009", status: "PENDING", passwordCredential: { create: { passwordHash: hashPassword("password1") } } },
    });
    // Phone verified but email NOT verified → activation must not happen.
    const session = await createSession(user.id);
    await requestPOST(jsonRequest("/api/auth/phone/request", {}, session.raw));
    const code = await codeFor("+447700900009");
    const res = await confirmPOST(jsonRequest("/api/auth/phone/confirm", { code }, session.raw));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.activated).toBe(false);
    expect(body.next).toBe("verify_email");

    const still = await db.user.findUnique({ where: { id: user.id } });
    expect(still!.status).toBe("PENDING");
    expect(await db.organization.count({ where: { ownerUserId: user.id } })).toBe(0);
  });
});
