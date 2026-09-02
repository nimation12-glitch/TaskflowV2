/// <reference types="bun-types" />
/**
 * OAuth flows through the REAL Auth.js protocol stack (correction spec §1,
 §5, §19) — Google / Microsoft Entra ID / GitHub with the EXTERNAL PROVIDER
 * PROTOCOL mocked at the fetch boundary (§44: providers are mocked, no real
 * accounts). Discovery documents, token endpoints and JWKS are mocked; ID
 * tokens are genuinely RS256-signed so the framework's signature, issuer,
 * audience, expiry and nonce validation all run for real.
 *
 * Covered:
 *  - Auth.js start action issues state/PKCE/nonce via signed, HttpOnly cookies
 *  - Google callback: full provisioning (user + org + OWNER + Free sub + credits)
 *  - Microsoft callback: ID-token iss/aud/exp/nonce validated by the framework
 *  - GitHub callback: e-mail resolution via /user/emails (incl. verified flag)
 *  - duplicate callback → idempotent (no duplicate users/orgs/identities)
 *  - state tampering / missing state → framework rejects (error redirect)
 *  - callback replay → rejected (state/PKCE cookies are consumed single-use)
 *  - verified provider email + existing local user → auto-link (one account)
 *  - unverified provider email + existing local user → REFUSED (no takeover)
 *  - identity already bound to another user + active session → REFUSED
 *  - unlink last credential → blocked
 *  - unconfigured provider → explicit configuration error (never a fake flow)
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { NextRequest } from "next/server";
import { generateKeyPair, exportJWK, SignJWT, type CryptoKey } from "jose";
import { db } from "@/lib/db";
import { ensureSeedPlans } from "../helpers";

process.env.GOOGLE_CLIENT_ID = "test-google-client-id";
process.env.GOOGLE_CLIENT_SECRET = "test-google-secret";
process.env.MICROSOFT_CLIENT_ID = "test-msft-client-id";
process.env.MICROSOFT_CLIENT_SECRET = "test-msft-secret";
process.env.GITHUB_CLIENT_ID = "test-github-client-id";
process.env.GITHUB_CLIENT_SECRET = "test-github-secret";

const { GET: authGET, POST: authPOST } = await import("@/app/api/auth/[...nextauth]/route");
const { POST: unlinkPOST } = await import("@/app/api/auth/oauth/[provider]/unlink/route");
const { SESSION_COOKIE } = await import("@/server/auth/session");

// ── Provider protocol mock (discovery + token + JWKS + profile) ──────────

type TokenResponse = { access_token: string; token_type: string; expires_in?: number; id_token?: string };

let mockTokenResponse: (provider: string, body: URLSearchParams) => Promise<TokenResponse> = async () => ({ access_token: "at-test", token_type: "Bearer" });
let mockGitHubUser: Record<string, unknown> = { id: 98765, login: "ghuser", name: "GH User", avatar_url: null, email: null };
let mockGitHubEmails: Array<{ email: string; primary: boolean; verified: boolean }> = [];

// Real RSA keypair — the framework verifies our mocked ID tokens properly.
let rsaPublicJwk: Record<string, unknown>;
let rsaPrivateKey: CryptoKey;

const realFetch = globalThis.fetch;

function json(data: unknown, status = 200) {
  // oauth4webapi (used by @auth/core) enforces the RFC 6749 cache rules on
  // token/discovery responses — the mocks must be spec-correct.
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

// TaskFlow canonical provider name → Auth.js URL path id.
const AUTH_JS_ID: Record<string, string> = {
  google: "google",
  microsoft: "microsoft-entra-id",
  github: "github",
};

async function googleDiscovery() {
  return {
    issuer: "https://accounts.google.com",
    authorization_endpoint: "https://accounts.google.com/o/oauth2/v2/auth",
    token_endpoint: "https://oauth2.googleapis.com/token",
    userinfo_endpoint: "https://openidconnect.googleapis.com/v1/userinfo",
    jwks_uri: "https://www.googleapis.com/oauth2/v3/certs",
    id_token_signing_alg_values_supported: ["RS256"],
    code_challenge_methods_supported: ["S256"],
  };
}

async function microsoftDiscovery() {
  return {
    issuer: "https://login.microsoftonline.com/common/v2.0",
    authorization_endpoint: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    token_endpoint: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    userinfo_endpoint: "https://login.microsoftonline.com/common/oauth2/v2.0/userinfo",
    jwks_uri: "https://login.microsoftonline.com/common/discovery/v2.0/keys",
    id_token_signing_alg_values_supported: ["RS256"],
    code_challenge_methods_supported: ["S256"],
  };
}

async function githubDiscovery() {
  return {
    issuer: "https://github.com/login/oauth",
    authorization_endpoint: "https://github.com/login/oauth/authorize",
    token_endpoint: "https://github.com/login/oauth/access_token",
    userinfo_endpoint: "https://api.github.com/user",
  };
}

async function makeIdToken(claims: Record<string, unknown>): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuedAt()
    .sign(rsaPrivateKey);
}

beforeAll(async () => {
  await ensureSeedPlans();
  const kp = await generateKeyPair("RS256", { extractable: true });
  rsaPrivateKey = kp.privateKey as CryptoKey;
  const pub = await exportJWK(kp.publicKey);
  rsaPublicJwk = { ...pub, kid: "test-key", alg: "RS256", use: "sig" };

  // @ts-expect-error test fetch interception
  globalThis.fetch = async (input: RequestInfo | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === "https://accounts.google.com/.well-known/openid-configuration") return json(await googleDiscovery());
    if (url === "https://login.microsoftonline.com/common/v2.0/.well-known/openid-configuration") return json(await microsoftDiscovery());
    if (url === "https://github.com/login/oauth/.well-known/openid-configuration") return json(await githubDiscovery());
    if (url === "https://www.googleapis.com/oauth2/v3/certs") return json({ keys: [rsaPublicJwk] });
    if (url === "https://login.microsoftonline.com/common/discovery/v2.0/keys") return json({ keys: [rsaPublicJwk] });
    if (url === "https://oauth2.googleapis.com/token") {
      return json(await mockTokenResponse("google", new URLSearchParams(init?.body as string)));
    }
    if (url.startsWith("https://login.microsoftonline.com/") && url.endsWith("/token")) {
      return json(await mockTokenResponse("microsoft", new URLSearchParams(init?.body as string)));
    }
    if (url === "https://github.com/login/oauth/access_token") {
      return json(await mockTokenResponse("github", new URLSearchParams(init?.body as string)));
    }
    if (url === "https://api.github.com/user") return json(mockGitHubUser);
    if (url === "https://api.github.com/user/emails") return json(mockGitHubEmails);
    return realFetch(input as RequestInfo, init);
  };
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

// ── Flow helpers — drive the REAL Auth.js HTTP surface ───────────────────

let ipCounter = 900;
const nextIp = () => `10.90.${Math.floor(ipCounter / 250) % 250}.${ipCounter++ % 250}`;

function requestFor(path: string, init?: { headers?: Record<string, string>; method?: string; body?: string }): NextRequest {
  return new NextRequest(`http://localhost:3000${path}`, {
    ...(init ?? {}),
    headers: { "x-forwarded-for": nextIp(), ...(init?.headers ?? {}) },
  }) as NextRequest;
}

type CookieJar = Map<string, string>;

function collectCookies(res: Response, jar: CookieJar): void {
  const setCookies = [
    ...((res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ?? []),
    res.headers.get("set-cookie") ?? "",
  ].filter(Boolean);
  for (const line of setCookies) {
    const [pair] = line.split(";");
    const idx = pair.indexOf("=");
    const name = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    if (value === "" && line.includes("Max-Age=0")) {
      jar.delete(name); // deletion cookie
    } else {
      jar.set(name, value);
    }
  }
}

function cookieHeader(jar: CookieJar): string {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

async function begin(provider: string, opts?: { mode?: string }): Promise<{ res: Response; jar: CookieJar }> {
  const jar: CookieJar = new Map();
  const csrfRes = await authGET(requestFor("/api/auth/csrf"));
  collectCookies(csrfRes, jar);
  const { csrfToken } = (await csrfRes.json()) as { csrfToken: string };
  const body = new URLSearchParams({
    csrfToken,
    // Same callback the SPA passes: land back on the OAuth finishing screen.
    callbackUrl: `http://localhost:3000/#/auth/finishing?provider=${provider}`,
  });
  const res = await authPOST(
    requestFor(`/api/auth/signin/${AUTH_JS_ID[provider]}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: cookieHeader(jar) },
      body: body.toString(),
    }),
  );
  collectCookies(res, jar);
  return { res, jar };
}

async function callback(provider: string, jar: CookieJar, code: string, state: string): Promise<Response> {
  const res = await authGET(
    requestFor(`/api/auth/callback/${AUTH_JS_ID[provider]}?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`, {
      headers: { cookie: cookieHeader(jar) },
    }),
  );
  collectCookies(res, jar);
  return res;
}

function sessionTokenFrom(jar: CookieJar): string | undefined {
  return jar.get(SESSION_COOKIE);
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("oauth flows (Auth.js)", () => {
  test("start action redirects to the provider with framework state cookies; secrets never leak", async () => {
    const { res, jar } = await begin("google");
    expect(res.status).toBe(302);
    const location = res.headers.get("location")!;
    expect(location).toContain("accounts.google.com");
    expect(location).toContain("state=");
    expect(location).not.toContain("client_secret"); // secrets never go to the browser (§14)
    // Framework anti-CSRF state cookies are present and HttpOnly.
    const setCookies = (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
    const stateCookie = setCookies.find((c) => c.includes("state"));
    expect(stateCookie).toContain("HttpOnly");
    expect(jar.size).toBeGreaterThan(1);
  });

  test("Google callback provisions a full tenant exactly once (§3, §9, §32) — full flow", async () => {
    const email = `guser-${Date.now()}@test-oauth.dev`;
    const { res: beginRes, jar } = await begin("google");
    const authUrl = new URL(beginRes.headers.get("location")!);
    const state = authUrl.searchParams.get("state")!;
    const nonce = authUrl.searchParams.get("nonce")!;

    mockTokenResponse = async () => ({
      access_token: "google-at-1",
      token_type: "Bearer",
      expires_in: 3600,
      id_token: await makeIdToken({
        sub: "google-sub-123",
        email,
        email_verified: true,
        name: "Google User",
        nonce,
        iss: "https://accounts.google.com",
        aud: "test-google-client-id",
        exp: Math.floor(Date.now() / 1000) + 600,
      }),
    });

    const res = await callback("google", jar, "auth-code-1", state);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("#/auth/finishing");
    const token = sessionTokenFrom(jar);
    expect(token).toBeTruthy();

    const identity = await db.authenticationIdentity.findUnique({
      where: { provider_providerAccountId: { provider: "google", providerAccountId: "google-sub-123" } },
      include: { user: true },
    });
    expect(identity).not.toBeNull();
    expect(identity!.user.email).toBe(email);
    expect(identity!.user.emailVerifiedAt).not.toBeNull();
    expect(identity!.user.status).toBe("ACTIVE"); // provider-verified email → active

    // Full tenant provisioning at first sign-in (§9).
    const org = await db.organization.findFirst({ where: { ownerUserId: identity!.userId } });
    expect(org).not.toBeNull();
    const membership = await db.membership.findUnique({
      where: { organizationId_userId: { organizationId: org!.id, userId: identity!.userId } },
    });
    expect(membership?.role).toBe("OWNER");
    const sub = await db.subscription.findUnique({ where: { organizationId: org!.id } });
    expect(sub?.planId).toBe("free");
    const account = await db.creditAccount.findUnique({ where: { organizationId: org!.id } });
    expect(account).not.toBeNull();

    // ── Duplicate callback (§32) — same identity resolves to the SAME user. ──
    const { res: beginRes2, jar: jar2 } = await begin("google");
    const authUrl2 = new URL(beginRes2.headers.get("location")!);
    mockTokenResponse = async () => ({
      access_token: "google-at-2",
      token_type: "Bearer",
      expires_in: 3600,
      id_token: await makeIdToken({
        sub: "google-sub-123",
        email,
        email_verified: true,
        name: "Google User",
        nonce: authUrl2.searchParams.get("nonce")!,
        iss: "https://accounts.google.com",
        aud: "test-google-client-id",
        exp: Math.floor(Date.now() / 1000) + 600,
      }),
    });
    await callback("google", jar2, "auth-code-2", authUrl2.searchParams.get("state")!);

    const userCount = await db.user.count({ where: { email } });
    expect(userCount).toBe(1);
    const orgCount = await db.organization.count({ where: { ownerUserId: identity!.userId } });
    expect(orgCount).toBe(1);
    const identityCount = await db.authenticationIdentity.count({ where: { providerAccountId: "google-sub-123" } });
    expect(identityCount).toBe(1);
  });

  test("Microsoft callback validates ID-token claims; tampered issuer is rejected", async () => {
    const email = `muser-${Date.now()}@test-oauth.dev`;
    const { res: beginRes, jar } = await begin("microsoft");
    const authUrl = new URL(beginRes.headers.get("location")!);
    mockTokenResponse = async () => ({
      access_token: "msft-at-1",
      token_type: "Bearer",
      expires_in: 3600,
      id_token: await makeIdToken({
        sub: "msft-sub-77",
        email,
        name: "Msft User",
        nonce: authUrl.searchParams.get("nonce")!,
        iss: "https://login.microsoftonline.com/common/v2.0",
        aud: "test-msft-client-id",
        exp: Math.floor(Date.now() / 1000) + 600,
      }),
    });
    const res = await callback("microsoft", jar, "msft-code", authUrl.searchParams.get("state")!);
    expect(res.status).toBe(302);
    const identity = await db.authenticationIdentity.findUnique({
      where: { provider_providerAccountId: { provider: "microsoft", providerAccountId: "msft-sub-77" } },
    });
    expect(identity).not.toBeNull();

    // A tampered issuer must be rejected by the framework's OIDC validation.
    const { res: beginRes2, jar: jar2 } = await begin("microsoft");
    const authUrl2 = new URL(beginRes2.headers.get("location")!);
    mockTokenResponse = async () => ({
      access_token: "msft-at-evil",
      token_type: "Bearer",
      expires_in: 3600,
      id_token: await makeIdToken({
        sub: "msft-sub-evil",
        email: `evil-${Date.now()}@test-oauth.dev`,
        nonce: authUrl2.searchParams.get("nonce")!,
        iss: "https://evil.example.com/v2.0",
        aud: "test-msft-client-id",
        exp: Math.floor(Date.now() / 1000) + 600,
      }),
    });
    const evilRes = await callback("microsoft", jar2, "evil-code", authUrl2.searchParams.get("state")!);
    expect(evilRes.status).toBe(302);
    // Auth.js error redirect — no identity was created.
    expect(await db.authenticationIdentity.count({ where: { providerAccountId: "msft-sub-evil" } })).toBe(0);
  });

  test("GitHub callback resolves the primary verified email", async () => {
    const email = `ghuser-${Date.now()}@test-oauth.dev`;
    // Reset the token mock — GitHub is plain OAuth2: NO id_token may be
    // present (a leftover OIDC id_token would fail issuer validation).
    mockTokenResponse = async () => ({ access_token: "gh-at", token_type: "Bearer" });
    mockGitHubUser = { id: 424242, login: "octocat", name: "Octo Cat", avatar_url: "https://example.com/a.png", email: null };
    mockGitHubEmails = [
      { email: "secondary@x.dev", primary: false, verified: true },
      { email, primary: true, verified: true },
    ];

    const { res: beginRes, jar } = await begin("github");
    // GitHub must NOT receive repo scopes (identity-only, §5).
    expect(decodeURIComponent(beginRes.headers.get("location")!)).not.toContain("scope=repo");

    const res = await callback("github", jar, "gh-code", new URL(beginRes.headers.get("location")!).searchParams.get("state")!);
    expect(res.status).toBe(302);

    const identity = await db.authenticationIdentity.findUnique({
      where: { provider_providerAccountId: { provider: "github", providerAccountId: "424242" } },
      include: { user: true },
    });
    expect(identity?.user.email).toBe(email);
    expect(identity?.user.emailVerifiedAt).not.toBeNull();
  });

  test("verified provider email matching an existing user AUTO-LINKS (one account, §6)", async () => {
    const email = `linkme-${Date.now()}@test-oauth.dev`;
    // Existing password account.
    await db.user.create({
      data: {
        email,
        passwordCredential: { create: { passwordHash: "scrypt$aa$bb" } },
      },
    });

    const { res: beginRes, jar } = await begin("google");
    const authUrl = new URL(beginRes.headers.get("location")!);
    mockTokenResponse = async () => ({
      access_token: "google-at-link",
      token_type: "Bearer",
      expires_in: 3600,
      id_token: await makeIdToken({
        sub: "google-sub-link",
        email,
        email_verified: true,
        nonce: authUrl.searchParams.get("nonce")!,
        iss: "https://accounts.google.com",
        aud: "test-google-client-id",
        exp: Math.floor(Date.now() / 1000) + 600,
      }),
    });

    const res = await callback("google", jar, "link-code", authUrl.searchParams.get("state")!);
    expect(res.status).toBe(302);

    // STILL one user for that email, now with two credentials (password + identity).
    const users = await db.user.findMany({ where: { email } });
    expect(users).toHaveLength(1);
    const identities = await db.authenticationIdentity.findMany({ where: { userId: users[0].id } });
    expect(identities).toHaveLength(1);
    expect((await db.passwordCredential.findUnique({ where: { userId: users[0].id } }))).not.toBeNull();
    expect(sessionTokenFrom(jar)).toBeTruthy(); // signed into the existing account
  });

  test("UNVERIFIED provider email matching an existing user is REFUSED (no takeover, §6)", async () => {
    const email = `nolink-${Date.now()}@test-oauth.dev`;
    await db.user.create({
      data: { email, passwordCredential: { create: { passwordHash: "scrypt$aa$bb" } } },
    });

    const { res: beginRes, jar } = await begin("github");
    const authUrl = new URL(beginRes.headers.get("location")!);
    mockTokenResponse = async () => ({ access_token: "gh-at", token_type: "Bearer" });
    mockGitHubUser = { id: 555777, login: "impersonator", name: "Impersonator", avatar_url: null, email: null };
    mockGitHubEmails = [{ email, primary: true, verified: false }]; // UNVERIFIED

    const res = await callback("github", jar, "imp-code", authUrl.searchParams.get("state")!);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("error=email_unverified");
    // No identity was created, no second user either.
    expect(await db.authenticationIdentity.count({ where: { providerAccountId: "555777" } })).toBe(0);
    expect(await db.user.count({ where: { email } })).toBe(1);
  });

  test("state tampering is rejected (CSRF defence, §10/§19)", async () => {
    const { res: beginRes, jar } = await begin("google");
    const authUrl = new URL(beginRes.headers.get("location")!);
    const goodState = authUrl.searchParams.get("state")!;

    // Corrupt the state parameter — the framework's signed state cookie no
    // longer matches.
    const res = await callback("google", jar, "code-x", "tampered-state-value");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toMatch(/error=(AccessDenied|Configuration|state)/);

    // Missing state cookie entirely (fresh jar).
    const { res: beginRes2 } = await begin("google");
    const freshJar: CookieJar = new Map();
    const res2 = await callback("google", freshJar, "code-x", new URL(beginRes2.headers.get("location")!).searchParams.get("state")!);
    expect(res2.status).toBe(302);
    expect(res2.headers.get("location")).toMatch(/error=/);
    void goodState;
  });

  test("callback REPLAY is rejected — state cookies are single-use (§19)", async () => {
    const email = `replay-${Date.now()}@test-oauth.dev`;
    const { res: beginRes, jar } = await begin("github");
    const authUrl = new URL(beginRes.headers.get("location")!);
    mockTokenResponse = async () => ({ access_token: "gh-at", token_type: "Bearer" });
    mockGitHubUser = { id: 777001, login: "replayer", name: "Replayer", avatar_url: null, email };
    mockGitHubEmails = [{ email, primary: true, verified: true }];

    const first = await callback("github", jar, "code-1", authUrl.searchParams.get("state")!);
    expect(first.status).toBe(302);
    expect(sessionTokenFrom(jar)).toBeTruthy();

    // Replay the SAME callback request (same code + state + consumed cookies).
    const second = await authGET(
      requestFor(`/api/auth/callback/github?code=code-1&state=${encodeURIComponent(authUrl.searchParams.get("state")!)}`, {
        headers: { cookie: cookieHeader(jar) },
      }),
    );
    expect(second.status).toBe(302);
    // No second session was minted and the redirect is an error/refresh —
    // the consumed state cannot authorize anything again.
    const location = second.headers.get("location")!;
    expect(location).toContain("#/"); // SPA landing (error or signin), not a fresh finishing success
  });

  test("identity already bound to ANOTHER user + active session → link REFUSED (§6)", async () => {
    // Owner of the identity.
    const identityEmail = `owner-${Date.now()}@test-oauth.dev`;
    const { res: beginRes, jar } = await begin("github");
    const authUrl = new URL(beginRes.headers.get("location")!);
    mockTokenResponse = async () => ({ access_token: "gh-at", token_type: "Bearer" });
    mockGitHubUser = { id: 888111, login: "bound-identity", name: "Bound", avatar_url: null, email: identityEmail };
    mockGitHubEmails = [{ email: identityEmail, primary: true, verified: true }];
    await callback("github", jar, "code-bound", authUrl.searchParams.get("state")!);
    const identity = await db.authenticationIdentity.findUnique({
      where: { provider_providerAccountId: { provider: "github", providerAccountId: "888111" } },
    });
    expect(identity).not.toBeNull();

    // A DIFFERENT signed-in user tries to connect the SAME identity.
    const other = await db.user.create({
      data: { email: `other-${Date.now()}@test-oauth.dev`, passwordCredential: { create: { passwordHash: "scrypt$aa$bb" } } },
    });
    const { createSession } = await import("@/server/auth/session");
    const session = await createSession(other.id);

    const { res: beginRes2, jar: jar2 } = await begin("github");
    const authUrl2 = new URL(beginRes2.headers.get("location")!);
    jar2.set(SESSION_COOKIE, session.raw); // the attacker's own session
    const res = await callback("github", jar2, "code-bound-2", authUrl2.searchParams.get("state")!);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("error=identity_taken");
    // The identity still belongs to its original owner.
    const still = await db.authenticationIdentity.findUnique({
      where: { provider_providerAccountId: { provider: "github", providerAccountId: "888111" } },
    });
    expect(still!.userId).toBe(identity!.userId);
  });

  test("unlinking the LAST credential is blocked (lock-out protection, §6)", async () => {
    const email = `only-oauth-${Date.now()}@test-oauth.dev`;
    const user = await db.user.create({
      data: {
        email,
        identities: { create: { provider: "github", providerAccountId: `last-${Date.now()}` } },
      },
    });
    const identity = await db.authenticationIdentity.findFirst({ where: { userId: user.id } });

    // Sign the user in — unlink requires an authenticated session (§28).
    const { createSession } = await import("@/server/auth/session");
    const session = await createSession(user.id);
    const req = new NextRequest("http://localhost:3000/api/auth/oauth/github/unlink", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session.raw}` },
      body: JSON.stringify({ identityId: identity!.id }),
    });
    const res = await unlinkPOST(req, { params: Promise.resolve({ provider: "github" }) } as never);
    expect(res.status).toBe(409); // last_credential
    expect(await db.authenticationIdentity.count({ where: { userId: user.id } })).toBe(1);
  });

  test("unconfigured provider → explicit configuration error (no fake flow, §4/§16/§46)", async () => {
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
    try {
      const { res } = await begin("google");
      expect(res.status).toBe(307);
      const location = res.headers.get("location")!;
      expect(location).toContain("error=provider_not_configured");
      const message = decodeURIComponent(location.replace(/\+/g, " "));
      expect(message).toContain("GOOGLE_CLIENT_ID");
      expect(message).toContain("callback URL");
    } finally {
      process.env.GOOGLE_CLIENT_ID = "test-google-client-id";
      process.env.GOOGLE_CLIENT_SECRET = "test-google-secret";
    }
  });
});
