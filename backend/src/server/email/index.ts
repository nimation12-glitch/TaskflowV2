/**
 * Transactional email service (Phase 1 §35).
 *
 * Business logic NEVER talks to a provider directly — it calls sendEmail().
 * Transports:
 *   - dev-console (default in development): logs a token-free line and stores
 *     the full message in the EmailMessage outbox table (readable only via a
 *     non-production-only route) so local/sandbox flows can exercise
 *     verification/reset/invitation links end-to-end.
 *   - resend (production): RESEND_API_KEY gated; without it, production sends
 *     refuse (fail closed) with a loud operator warning — email-dependent
 *     features surface a clear error instead of pretending mail delivered.
 *
 * Tokens inside bodies are single-use, hashed-at-rest, expiring (tokens.ts).
 * Message rows are operational records — never contain credentials (§40).
 */
import { db } from "@/lib/db";
import { serverEnv } from "@/server/env";

export type EmailPayload = {
  to: string;
  subject: string;
  text: string;
};

export type EmailTemplate = { subject: string; text: string };

export type EmailSendResult = {
  ok: boolean;
  transport: string;
  /** Non-sensitive failure reason for callers/UI (never includes secrets). */
  error?: string;
};

async function sendViaResend(payload: EmailPayload): Promise<EmailSendResult> {
  const apiKey = serverEnv.resendApiKey;
  if (!apiKey) {
    return { ok: false, transport: "resend", error: "RESEND_API_KEY is not configured" };
  }
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: serverEnv.emailFrom,
        to: [payload.to],
        subject: payload.subject,
        text: payload.text,
      }),
    });
    if (!res.ok) {
      const reason =
        res.status === 401
          ? "email provider rejected credentials"
          : `email provider error (HTTP ${res.status})`;
      return { ok: false, transport: "resend", error: reason };
    }
    return { ok: true, transport: "resend" };
  } catch (err) {
    return {
      ok: false,
      transport: "resend",
      error: err instanceof Error ? err.message : "email provider unreachable",
    };
  }
}

async function sendViaDevConsole(payload: EmailPayload): Promise<EmailSendResult> {
  // Console line contains NO tokens — the full body (with its action link)
  // goes to the outbox table, readable only via the non-production route.
  console.log(
    `[email:dev] to=${payload.to} subject="${payload.subject}" (body stored in EmailMessage outbox)`,
  );
  return { ok: true, transport: "dev-console" };
}

/**
 * Send an email and persist an outbox record (both transports — the outbox
 * doubles as the production send audit).
 */
export async function sendEmail(payload: EmailPayload): Promise<EmailSendResult> {
  const transport = serverEnv.emailTransport;
  const result = transport === "resend" ? await sendViaResend(payload) : await sendViaDevConsole(payload);

  await db.emailMessage
    .create({
      data: {
        to: payload.to,
        subject: payload.subject,
        body: payload.text,
        transport: result.transport,
        status: result.ok ? "SENT" : "FAILED",
        error: result.error ?? null,
      },
    })
    .catch(() => undefined);

  if (!result.ok) {
    console.error(`[email] send FAILED via ${result.transport}: ${result.error}`);
  }
  return result;
}

/** Absolute URL the SPA uses for hash-routed action screens. */
export function appLink(hashPath: string, token: string): string {
  const base = serverEnv.frontendBaseUrl.replace(/\/$/, "");
  return `${base}/#${hashPath}?token=${encodeURIComponent(token)}`;
}

export const emailTemplates = {
  verifyEmail(link: string): EmailTemplate {
    return {
      subject: "Verify your TaskFlow email address",
      text: [
        "Welcome to TaskFlow!",
        "",
        "Confirm this email address to secure your account:",
        link,
        "",
        "The link expires in 24 hours. If you didn't create a TaskFlow account, ignore this email.",
      ].join("\n"),
    };
  },
  passwordReset(link: string): EmailTemplate {
    return {
      subject: "Reset your TaskFlow password",
      text: [
        "A password reset was requested for your TaskFlow account.",
        "",
        "Reset link (valid for 1 hour, single use):",
        link,
        "",
        "All active sessions are signed out when the password changes.",
        "If this wasn't you, no action is needed — your password remains unchanged.",
      ].join("\n"),
    };
  },
  organizationInvitation(orgName: string, link: string): EmailTemplate {
    return {
      subject: `You're invited to join ${orgName} on TaskFlow`,
      text: [
        `You've been invited to join the ${orgName} workspace on TaskFlow.`,
        "",
        "Accept your invitation (valid for 7 days, single use):",
        link,
        "",
        "The invitation is tied to this email address — sign in or register with it to accept.",
      ].join("\n"),
    };
  },
};
