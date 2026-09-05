import "server-only";

function backendUrl(path: string): string {
  const base = process.env.BACKEND_URL;
  if (!base) throw new Error("BACKEND_URL is not set");
  return `${base.replace(/\/$/, "")}${path}`;
}

function serviceSecret(): string {
  const secret = process.env.BACKEND_SERVICE_SECRET;
  if (!secret) throw new Error("BACKEND_SERVICE_SECRET is not set");
  return secret;
}

export type Membership = { organization_id: string; role: "OWNER" | "ADMIN" | "MEMBER" };

/**
 * Called once, the first time a person ever signs in (any method) — creates
 * their default Organization, an OWNER Membership, a Free Subscription, and
 * a CreditAccount. Idempotent on the backend, safe to call more than once.
 */
export async function bootstrapOrganization(params: {
  userId: string;
  displayName?: string | null;
  email: string;
}): Promise<{ organization_id: string; organization_name: string }> {
  const res = await fetch(backendUrl("/internal/bootstrap-organization"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-TaskFlow-Service-Secret": serviceSecret(),
    },
    body: JSON.stringify({
      user_id: params.userId,
      display_name: params.displayName,
      email: params.email,
    }),
  });
  if (!res.ok) {
    throw new Error(`bootstrapOrganization failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

export async function getMembershipsForUser(userId: string): Promise<Membership[]> {
  const res = await fetch(backendUrl(`/internal/memberships/${userId}`), {
    headers: { "X-TaskFlow-Service-Secret": serviceSecret() },
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`getMembershipsForUser failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  return data.memberships;
}

export async function acceptInvitation(params: { token: string; userId: string; email: string }) {
  const res = await fetch(backendUrl("/team/invitations/accept"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-TaskFlow-Service-Secret": serviceSecret(),
    },
    body: JSON.stringify({ token: params.token, user_id: params.userId, email: params.email }),
  });
  if (!res.ok) {
    throw new Error(await res.text());
  }
  return res.json();
}
