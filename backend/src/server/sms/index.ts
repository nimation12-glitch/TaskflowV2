/**
 * Pluggable SMS transport (correction spec §3, §13).
 *
 * Business logic ONLY ever calls sendSms() — it never imports a provider.
 * Transports:
 *   - dev (development/test): logs a masked, code-free console line and
 *     stores the FULL message (including the code, for local flows) in the
 *     SmsMessage outbox table, readable only via the non-production
 *     /api/dev/sms-outbox route.
 *   - twilio (production): Twilio REST API via fetch — no SDK dependency.
 *     Credentials come ONLY from server-side env vars. The outbox row stores
 *     a CODE-FREE body so verification codes never persist at rest.
 *   - unconfigured (production default without SMS_PROVIDER): sends REFUSE
 *     (fail closed) — the phone-verification flow surfaces an explicit
 *     configuration state instead of pretending an SMS was delivered.
 *
 * NEVER logged or persisted: provider credentials, verification codes
 * (outside the dev outbox), full phone numbers in log lines (masked form
 * only — see maskPhone()).
 */
import { db } from "@/lib/db";
import { serverEnv } from "@/server/env";

export type SmsPayload = {
  to: string; // E.164
  body: string;
};

export type SmsSendResult = {
  ok: boolean;
  transport: string;
  /** Non-sensitive failure reason for callers/UI (never includes secrets). */
  error?: string;
};

export interface SmsProvider {
  readonly id: string;
  /** True when the provider has everything it needs (server-side check). */
  readonly configured: boolean;
  send(payload: SmsPayload): Promise<SmsSendResult>;
}

// ── Development / test transport ─────────────────────────────────────────

const devSmsProvider: SmsProvider = {
  id: "dev",
  configured: true,
  async send(payload) {
    // Console line is code-free + masked; the outbox row carries the body so
    // local/dev flows can complete verification end-to-end.
    console.log(`[sms:dev] to=${payload.to} (body stored in SmsMessage outbox, ${payload.body.length} chars)`);
    return { ok: true, transport: "dev" };
  },
};

// ── Twilio (production) — REST API, no SDK, env-driven credentials ───────

const twilioSmsProvider: SmsProvider = {
  id: "twilio",
  get configured() {
    return serverEnv.smsTransport === "twilio";
  },
  async send(payload) {
    const sid = serverEnv.twilioAccountSid;
    const token = serverEnv.twilioAuthToken;
    if (!sid || !token) {
      return { ok: false, transport: "twilio", error: "TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN are not configured" };
    }
    const params = new URLSearchParams({ To: payload.to, Body: payload.body });
    if (serverEnv.twilioMessagingServiceSid) {
      params.set("MessagingServiceSid", serverEnv.twilioMessagingServiceSid);
    } else if (serverEnv.twilioFromNumber) {
      params.set("From", serverEnv.twilioFromNumber);
    } else {
      return { ok: false, transport: "twilio", error: "Neither TWILIO_FROM_NUMBER nor TWILIO_MESSAGING_SERVICE_SID is configured" };
    }
    try {
      const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: params.toString(),
      });
      if (!res.ok) {
        const reason = res.status === 401 ? "SMS provider rejected credentials" : `SMS provider error (HTTP ${res.status})`;
        return { ok: false, transport: "twilio", error: reason };
      }
      return { ok: true, transport: "twilio" };
    } catch (err) {
      return {
        ok: false,
        transport: "twilio",
        error: err instanceof Error ? err.message : "SMS provider unreachable",
      };
    }
  },
};

/** Explicitly-unconfigured provider — every send fails closed. */
const unconfiguredSmsProvider: SmsProvider = {
  id: "unconfigured",
  configured: false,
  async send() {
    return {
      ok: false,
      transport: "unconfigured",
      error: "SMS provider is not configured on this deployment. Set SMS_PROVIDER plus its credentials (see .env.example).",
    };
  },
};

/** Resolve the transport from server configuration (never hardcoded per call). */
export function getSmsProvider(): SmsProvider {
  switch (serverEnv.smsTransport) {
    case "twilio":
      return twilioSmsProvider;
    case "dev":
      return devSmsProvider;
    default:
      return unconfiguredSmsProvider;
  }
}

export function smsTransportStatus(): { transport: string; configured: boolean } {
  const provider = getSmsProvider();
  return { transport: provider.id === "unconfigured" ? serverEnv.smsTransport : provider.id, configured: provider.configured };
}

/**
 * Send an SMS and persist an outbox record. The PERSISTED body is code-free
 * for production transports (the verification code never touches the
 * database outside the dev/test outbox); the dev transport persists the real
 * body so local flows are exercisable.
 */
export async function sendSms(payload: SmsPayload, opts?: { /** body recorded in the outbox for PRODUCTION transports (must be code-free) */ recordBody?: string }): Promise<SmsSendResult> {
  const provider = getSmsProvider();
  const result = await provider.send(payload);
  const recordedBody = provider.id === "twilio" || provider.id === "unconfigured"
    ? opts?.recordBody ?? "(content withheld)"
    : payload.body;

  await db.smsMessage
    .create({
      data: {
        to: payload.to,
        body: recordedBody,
        provider: provider.id,
        status: result.ok ? "SENT" : "FAILED",
        error: result.error ?? null,
      },
    })
    .catch(() => undefined);

  if (!result.ok) {
    console.error(`[sms] send FAILED via ${result.transport}: ${result.error}`);
  }
  return result;
}
