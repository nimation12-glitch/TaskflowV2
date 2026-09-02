"use client";

/**
 * DevOutboxHelper — DEVELOPMENT/TEST AID ONLY (never renders in production).
 *
 * On deployments without a real email/SMS provider (dev transports), the
 * verification links and SMS codes land in the server-side outboxes
 * (EmailMessage / SmsMessage). This helper surfaces them in the UI so the
 * full signup → email-verify → phone-verify flow is completable from the
 * browser — without weakening anything: the backing endpoints
 * (/api/dev/email-outbox, /api/dev/sms-outbox) return 404 in production and
 * this component renders NOTHING when they are absent.
 *
 * The panel is explicitly labelled so nobody mistakes it for a production
 * feature (correction spec §12/§16: never fake delivery — surface truth).
 */
import { apiUrl } from "@/lib/client-api";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { FlaskConical, RefreshCw } from "lucide-react";

type EmailRow = { id: string; to: string; subject: string; body: string; createdAt: string };
type SmsRow = { id: string; to: string; body: string; createdAt: string };

type DevOutboxState =
  | { kind: "hidden" }
  | { kind: "loading" }
  | { kind: "empty" }
  | { kind: "email"; link: string; subject: string; createdAt: string }
  | { kind: "sms"; code: string; createdAt: string };

/** Mirror of the server's E.164 normalization so `to` filters match. */
function normalizeTo(kind: "email" | "sms", raw: string): string {
  const trimmed = raw.trim().toLowerCase();
  if (kind === "email") return trimmed;
  return trimmed.replace(/[\s\-().]/g, "");
}

/** Pure loader — reads the outbox, never touches component state. */
async function loadOutbox(kind: "email" | "sms", to: string): Promise<DevOutboxState> {
  const normalized = normalizeTo(kind, to);
  const endpoint = kind === "email" ? "/api/dev/email-outbox" : "/api/dev/sms-outbox";
  let rows: Array<EmailRow | SmsRow> = [];
  const filtered = await fetch(apiUrl(`${endpoint}?to=${encodeURIComponent(normalized)}`), { credentials: "include" });
  if (filtered.status === 404) return { kind: "hidden" }; // production — helper does not exist there
  if (filtered.ok) rows = ((await filtered.json()) as { messages: EmailRow[] | SmsRow[] }).messages ?? [];
  if (rows.length === 0 && normalized) {
    // Fallback for formatting differences (e.g. separators in a phone input).
    const all = await fetch(apiUrl(endpoint), { credentials: "include" });
    if (all.ok) {
      const allRows = ((await all.json()) as { messages: EmailRow[] | SmsRow[] }).messages ?? [];
      rows = allRows.filter((m) => normalizeTo(kind, m.to) === normalized);
    }
  }
  if (rows.length === 0) return { kind: "empty" };
  const newest = rows[0];
  if (kind === "email") {
    const row = newest as EmailRow;
    // The template bodies put the action URL on its own line; the SPA's
    // hash-routed action screens are #/verify-email, #/reset-password,
    // #/invite (see src/app/page.tsx).
    const match = row.body.match(/https:\/\/[^\s"<>]+#\/(?:verify-email|reset-password|invite)\?token=[^\s"<>]+/);
    if (!match) return { kind: "empty" };
    return { kind: "email", link: match[0], subject: row.subject, createdAt: row.createdAt };
  }
  const row = newest as SmsRow;
  const code = row.body.match(/\b(\d{6})\b/)?.[1];
  if (!code) return { kind: "empty" };
  return { kind: "sms", code, createdAt: row.createdAt };
}

export function DevOutboxHelper({ kind, to, onUseCode, refreshKey = 0 }: {
  kind: "email" | "sms";
  to: string | null;
  /** SMS only — fills the verification input with the surfaced code. */
  onUseCode?: (code: string) => void;
  /** Bump to re-fetch after a resend/send action. */
  refreshKey?: number;
}) {
  const [state, setState] = useState<DevOutboxState>(to ? { kind: "loading" } : { kind: "hidden" });

  useEffect(() => {
    if (!to) return;
    let cancelled = false;
    loadOutbox(kind, to)
      .then((result) => {
        if (!cancelled) setState(result);
      })
      .catch(() => {
        if (!cancelled) setState({ kind: "hidden" });
      });
    return () => {
      cancelled = true;
    };
  }, [kind, to, refreshKey]);

  function refresh() {
    if (!to) return;
    loadOutbox(kind, to)
      .then(setState)
      .catch(() => setState({ kind: "hidden" }));
  }

  if (state.kind === "hidden") return null;

  return (
    <div className="rounded-md border border-dashed border-amber-500/40 bg-amber-500/5 px-3 py-2.5 text-sm">
      <p className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-amber-300">
        <FlaskConical className="h-3.5 w-3.5" />
        Development outbox — this deployment has no real {kind === "email" ? "email" : "SMS"} provider configured
      </p>
      {state.kind === "loading" && <p className="text-xs text-slate-400">Checking the outbox…</p>}
      {state.kind === "empty" && (
        <p className="text-xs text-slate-400">
          No {kind === "email" ? "message" : "code"} found yet. Trigger a send (or resend) and refresh.
        </p>
      )}
      {state.kind === "email" && (
        <div className="flex items-center justify-between gap-2">
          <span className="min-w-0 truncate text-xs text-slate-300">{state.subject}</span>
          <Button
            type="button"
            size="sm"
            onClick={() => { window.location.assign(state.link); }}
            className="shrink-0 border-amber-400/50 bg-amber-500/15 text-amber-200 hover:bg-amber-500/25"
            variant="outline"
          >
            Open verification link
          </Button>
        </div>
      )}
      {state.kind === "sms" && (
        <div className="flex items-center justify-between gap-2">
          <span className="font-mono text-base tracking-[0.3em] text-amber-200">{state.code}</span>
          {onUseCode && (
            <Button
              type="button"
              size="sm"
              onClick={() => onUseCode(state.code)}
              className="shrink-0 border-amber-400/50 bg-amber-500/15 text-amber-200 hover:bg-amber-500/25"
              variant="outline"
            >
              Use this code
            </Button>
          )}
        </div>
      )}
      <button
        type="button"
        onClick={refresh}
        className="mt-1.5 flex items-center gap-1 text-xs text-slate-400 hover:text-white"
      >
        <RefreshCw className="h-3 w-3" /> Refresh
      </button>
    </div>
  );
}
