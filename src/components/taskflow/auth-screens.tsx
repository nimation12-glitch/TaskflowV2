"use client";

/**
 * Hash-routed auth-flow screens (Phase 1 §5, §21, §30; correction spec §2, §3, §17):
 *   AuthFinishingScreen       — OAuth callback landing (success/error surfacing)
 *   VerifyEmailScreen         — consumes the emailed verification token
 *   PendingVerificationScreen — the pending-account state: email verification
 *                               → phone verification → activation
 *   ResetPasswordScreen       — consumes the emailed reset token
 *   InviteScreen              — organization invitation preview + acceptance (§21)
 */

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, CheckCircle2, XCircle, Zap, Users, MailCheck, Smartphone } from "lucide-react";
import { post, api, ApiError } from "@/lib/client-api";
import { DevOutboxHelper } from "@/components/taskflow/dev-outbox-helper";
import type { MeResponse } from "@/types/taskflow";

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-950 p-4">
      <div className="w-full max-w-md">
        <Card className="border-white/10 bg-slate-900 text-slate-100">
          <CardHeader className="items-center text-center">
            <div className="mx-auto mb-2 flex h-11 w-11 items-center justify-center rounded-xl bg-emerald-500">
              <Zap className="h-5.5 w-5.5 text-slate-950" strokeWidth={2.5} />
            </div>
            {children}
          </CardHeader>
        </Card>
      </div>
    </div>
  );
}

export function AuthFinishingScreen({ onDone, onAuthed }: { onDone: () => void; onAuthed: () => void }) {
  const [checked, setChecked] = useState(false);
  const ran = useRef(false);
  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    (async () => {
      try {
        const res = await fetch("/api/auth/me", { credentials: "same-origin" });
        setChecked(true);
        if (res.ok) {
          const data = (await res.json()) as { user: unknown };
          if (data.user) {
            setTimeout(onAuthed, 700);
            return;
          }
        }
      } catch {
        setChecked(true);
      }
      setTimeout(onDone, 700);
    })();
  }, [onAuthed, onDone]);

  return (
    <Shell>
      <CardTitle className="text-xl">Finishing sign-in…</CardTitle>
      <CardDescription className="text-slate-400">
        {checked ? "Redirecting" : "Completing your OAuth sign-in"}
      </CardDescription>
      <Loader2 className="mx-auto mt-3 h-6 w-6 animate-spin text-emerald-400" />
    </Shell>
  );
}

export function VerifyEmailScreen({ token, onAuthed, onPending }: { token: string | null; onAuthed: () => void; onPending?: () => void }) {
  const [state, setState] = useState<"working" | "done" | "pending" | "error">(token ? "working" : "error");
  const [message, setMessage] = useState(token ? "" : "This verification link is missing its token.");

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    post<{ next?: string }>("/api/auth/verify-email", { token })
      .then((res) => {
        if (cancelled) return;
        // The account may still need phone verification before activation
        // (correction spec §17).
        if (res.next === "verify_phone") setState("pending");
        else setState("done");
      })
      .catch((err) => {
        if (!cancelled) {
          setState("error");
          setMessage(err instanceof ApiError ? err.message : "Verification failed");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  return (
    <Shell>
      {state === "working" && <Loader2 className="mx-auto h-6 w-6 animate-spin text-emerald-400" />}
      {state === "done" && (
        <>
          <CheckCircle2 className="mx-auto mb-2 h-10 w-10 text-emerald-400" />
          <CardTitle className="text-xl">Email verified</CardTitle>
          <CardDescription className="text-slate-400">Your email address is confirmed.</CardDescription>
          <Button onClick={onAuthed} className="mt-4 w-full bg-emerald-500 text-slate-950 hover:bg-emerald-400">
            Go to dashboard
          </Button>
        </>
      )}
      {state === "pending" && (
        <>
          <MailCheck className="mx-auto mb-2 h-10 w-10 text-emerald-400" />
          <CardTitle className="text-xl">Email verified</CardTitle>
          <CardDescription className="text-slate-400">
            One more step: verify your phone number to activate your workspace.
          </CardDescription>
          <Button onClick={() => onPending?.()} className="mt-4 w-full bg-emerald-500 text-slate-950 hover:bg-emerald-400">
            Verify phone number
          </Button>
        </>
      )}
      {state === "error" && (
        <>
          <XCircle className="mx-auto mb-2 h-10 w-10 text-rose-400" />
          <CardTitle className="text-xl">Verification failed</CardTitle>
          <CardDescription className="text-slate-400">{message}</CardDescription>
          <Button variant="outline" onClick={onAuthed} className="mt-4 w-full border-white/15 bg-slate-950 text-white hover:bg-slate-900">
            Continue to TaskFlow
          </Button>
        </>
      )}
    </Shell>
  );
}

/**
 * The pending-account state (correction spec §17): email verification →
 * phone verification → activation. Rendered for accounts whose verification
 * policy is not yet satisfied; the workspace is provisioned at activation.
 */
export function PendingVerificationScreen({ me, refreshMe, onAuthed, onSignOut }: {
  me: MeResponse | null;
  refreshMe: () => Promise<boolean>;
  onAuthed: () => void;
  onSignOut: () => void;
}) {
  const emailVerified = Boolean(me?.user?.emailVerified);
  // Derived step: advances automatically once a fresh /me payload shows the
  // email verified (e.g. after returning from the email-verification link).
  const [phoneStepOverride, setPhoneStepOverride] = useState(false);
  const step: "email" | "phone" = emailVerified || phoneStepOverride ? "phone" : "email";
  const [phone, setPhone] = useState(me?.user?.phone ?? "");
  const [code, setCode] = useState("");
  const [codeSent, setCodeSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const smsConfigured = me?.sms?.configured ?? true;
  // Dev-outbox helper refresh triggers (bumped after each send/resend so the
  // surfaced link/code reflects the newest message).
  const [emailSentAt, setEmailSentAt] = useState(0);
  const [smsSentAt, setSmsSentAt] = useState(0);

  // Freshen the payload on mount — the email may have just been verified via
  // the emailed link (which runs outside this screen's lifetime).
  const synced = useRef(false);
  useEffect(() => {
    if (synced.current) return;
    synced.current = true;
    refreshMe().catch(() => undefined);
  }, [refreshMe]);

  // Bootstrap resolves /me BEFORE routing here, so a null user at mount means
  // genuinely no session (e.g. the verification link was followed on a
  // different front than the one the signup happened on) — bounce to sign-in
  // instead of showing a meaningless "Pending" state.
  useEffect(() => {
    if (me === null) onSignOut();
  }, [me, onSignOut]);

  async function resendEmail() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await post<{ sent?: boolean; alreadyVerified?: boolean }>("/api/auth/resend-verification", {});
      if (res.alreadyVerified) {
        await refreshMe();
      } else if (res.sent === false) {
        setError("The email provider did not accept the message. Email delivery is not configured on this deployment.");
      } else {
        setNotice("Verification email sent — check your inbox.");
        setEmailSentAt(Date.now());
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not resend the email");
    } finally {
      setBusy(false);
    }
  }

  async function requestCode() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await post<{ sent: boolean; smsAccepted?: boolean; error?: string; reason?: string }>("/api/auth/phone/request", phone ? { phone } : {});
      if (res.sent) {
        if (res.smsAccepted === false) {
          setError(res.error ?? "The SMS provider did not accept the message.");
        } else {
          setCodeSent(true);
          setNotice("Verification code sent by SMS.");
          setSmsSentAt(Date.now());
        }
      } else {
        setError(res.error ?? "The SMS provider did not accept the message.");
      }
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "Could not send the code";
      setError(message);
      if (message.includes("not configured")) setNotice("SMS delivery is not configured on this deployment (see .env.example).");
    } finally {
      setBusy(false);
    }
  }

  async function confirmCode(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await post<{ activated: boolean; next?: string | null }>("/api/auth/phone/confirm", { code });
      if (res.next === "verify_email") {
        await refreshMe();
      } else {
        await refreshMe();
        onAuthed();
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Verification failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Shell>
      <CardTitle className="text-xl">
        {step === "email" ? "Verify your email" : "Verify your phone"}
      </CardTitle>
      <CardDescription className="text-slate-400">
        Your workspace activates once both verifications complete
        {me?.user?.email ? ` (${me.user.email})` : ""}.
      </CardDescription>
      <div className="mt-4 w-full space-y-4">
        <div className="flex items-center justify-between rounded-md border border-white/10 bg-slate-950 px-3 py-2 text-sm">
          <span className="flex items-center gap-2 text-slate-300">
            <MailCheck className="h-4 w-4 text-slate-500" /> Email verification
          </span>
          <span className={emailVerified ? "text-emerald-400" : "text-amber-400"}>
            {emailVerified ? "Verified" : "Pending"}
          </span>
        </div>
        <div className="flex items-center justify-between rounded-md border border-white/10 bg-slate-950 px-3 py-2 text-sm">
          <span className="flex items-center gap-2 text-slate-300">
            <Smartphone className="h-4 w-4 text-slate-500" /> Phone verification
          </span>
          <span className={step === "phone" ? "text-amber-400" : "text-slate-500"}>
            {step === "phone" ? "Pending" : "Waiting"}
          </span>
        </div>

        {step === "email" && (
          <div className="space-y-3">
            <Button onClick={resendEmail} disabled={busy} className="w-full bg-emerald-500 text-slate-950 hover:bg-emerald-400">
              {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />} Resend verification email
            </Button>
            <DevOutboxHelper kind="email" to={me?.user?.email ?? null} refreshKey={emailSentAt} />
            <Button variant="ghost" onClick={onSignOut} className="w-full text-slate-400 hover:text-white">
              Use a different account
            </Button>
          </div>
        )}

        {step === "phone" && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (codeSent) void confirmCode(e);
            }}
            className="space-y-3"
          >
            <div className="space-y-2">
              <Label htmlFor="pending-phone" className="text-slate-300">Phone number</Label>
              <div className="flex gap-2">
                <Input
                  id="pending-phone"
                  type="tel"
                  required
                  placeholder="+44 7700 900123"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  disabled={codeSent}
                  className="border-white/15 bg-slate-950 text-white placeholder:text-slate-600"
                  autoComplete="tel"
                />
                <Button type="button" onClick={requestCode} disabled={busy || !phone} variant="outline" className="border-white/15 bg-slate-950 text-white hover:bg-slate-900">
                  Send code
                </Button>
              </div>
              {!smsConfigured && (
                <p className="text-xs text-amber-300">
                  SMS delivery is not configured on this deployment — codes cannot be sent until SMS_PROVIDER is set (see .env.example).
                </p>
              )}
            </div>
            {codeSent && (
              <div className="space-y-2">
                <Label htmlFor="pending-code" className="text-slate-300">6-digit code</Label>
                <Input
                  id="pending-code"
                  inputMode="numeric"
                  pattern="\d{6}"
                  required
                  placeholder="123456"
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  className="border-white/15 bg-slate-950 text-center text-lg tracking-[0.4em] text-white placeholder:text-slate-600"
                  autoComplete="one-time-code"
                />
                <Button type="submit" disabled={busy || code.length !== 6} className="w-full bg-emerald-500 text-slate-950 hover:bg-emerald-400">
                  {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />} Verify and activate
                </Button>
                <DevOutboxHelper
                  kind="sms"
                  to={phone}
                  onUseCode={(c) => setCode(c)}
                  refreshKey={smsSentAt}
                />
                <button
                  type="button"
                  className="text-xs text-slate-400 hover:text-white"
                  onClick={() => { setCodeSent(false); setCode(""); setNotice(null); }}
                >
                  Change number / resend
                </button>
              </div>
            )}
          </form>
        )}

        {error && <p className="rounded-md border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-300">{error}</p>}
        {notice && <p className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300">{notice}</p>}
      </div>
    </Shell>
  );
}

export function ResetPasswordScreen({ token, onDone }: { token: string | null; onDone: () => void }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await post("/api/auth/reset-password", { token, password });
      setDone(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Reset failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Shell>
      {done ? (
        <>
          <CheckCircle2 className="mx-auto mb-2 h-10 w-10 text-emerald-400" />
          <CardTitle className="text-xl">Password updated</CardTitle>
          <CardDescription className="text-slate-400">All previous sessions were signed out.</CardDescription>
          <Button onClick={onDone} className="mt-4 w-full bg-emerald-500 text-slate-950 hover:bg-emerald-400">
            Sign in
          </Button>
        </>
      ) : (
        <>
          <CardTitle className="text-xl">Choose a new password</CardTitle>
          <CardDescription className="text-slate-400">At least 8 characters with letters and numbers.</CardDescription>
          <form onSubmit={submit} className="mt-3 w-full space-y-4">
            <div className="space-y-2">
              <Label htmlFor="reset-pw" className="text-slate-300">New password</Label>
              <Input
                id="reset-pw"
                type="password"
                required
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="border-white/15 bg-slate-950 text-white"
                autoComplete="new-password"
              />
            </div>
            {error && <p className="rounded-md border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-300">{error}</p>}
            <Button type="submit" disabled={busy || !token} className="w-full bg-emerald-500 text-slate-950 hover:bg-emerald-400">
              {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />} {token ? "Update password" : "Missing reset token"}
            </Button>
          </form>
        </>
      )}
    </Shell>
  );
}

type InvitePreview = { organizationName: string; invitedEmail: string; role: string };

export function InviteScreen({ token, me, onAuthed, onGoAuth }: {
  token: string | null;
  me: MeResponse | null;
  onAuthed: () => void;
  onGoAuth: () => void;
}) {
  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "accepted" | "error">(token ? "loading" : "error");
  const [message, setMessage] = useState(token ? "" : "This invitation link is missing its token.");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    api<InvitePreview>(`/api/invitations/lookup?token=${encodeURIComponent(token)}`)
      .then((p) => {
        if (!cancelled) {
          setPreview(p);
          setState("ready");
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setState("error");
          setMessage(err instanceof ApiError ? err.message : "This invitation is not valid.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  async function accept() {
    if (!token) return;
    setBusy(true);
    try {
      const res = await post<{ organizationName: string }>("/api/invitations/accept", { token });
      setMessage(res.organizationName);
      setState("accepted");
    } catch (err) {
      setState("error");
      setMessage(err instanceof ApiError ? err.message : "Accept failed");
    } finally {
      setBusy(false);
    }
  }

  if (state === "accepted") {
    return (
      <Shell>
        <Users className="mx-auto mb-2 h-10 w-10 text-emerald-400" />
        <CardTitle className="text-xl">Welcome to {message}</CardTitle>
        <CardDescription className="text-slate-400">You are now a member of this organization.</CardDescription>
        <Button onClick={onAuthed} className="mt-4 w-full bg-emerald-500 text-slate-950 hover:bg-emerald-400">
          Open organization
        </Button>
      </Shell>
    );
  }

  if (state === "error") {
    return (
      <Shell>
        <XCircle className="mx-auto mb-2 h-10 w-10 text-rose-400" />
        <CardTitle className="text-xl">Invitation unavailable</CardTitle>
        <CardDescription className="text-slate-400">{message}</CardDescription>
      </Shell>
    );
  }

  return (
    <Shell>
      <CardTitle className="text-xl">Organization invitation</CardTitle>
      {state === "loading" || !preview ? (
        <Loader2 className="mx-auto h-6 w-6 animate-spin text-emerald-400" />
      ) : (
        <>
          <CardDescription className="text-slate-400">
            You've been invited to join <strong className="text-slate-200">{preview.organizationName}</strong> as{" "}
            <strong className="text-slate-200">{preview.role}</strong>. The invitation is tied to{" "}
            <strong className="text-slate-200">{preview.invitedEmail}</strong>.
          </CardDescription>
          {me?.user ? (
            me.user.email.toLowerCase() === preview.invitedEmail.toLowerCase() ? (
              <Button onClick={accept} disabled={busy} className="mt-4 w-full bg-emerald-500 text-slate-950 hover:bg-emerald-400">
                {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />} Accept invitation
              </Button>
            ) : (
              <div className="mt-2 w-full">
                <p className="mb-2 text-sm text-amber-300">
                  You're signed in as {me.user.email}. Sign in as {preview.invitedEmail} to accept.
                </p>
                <Button
                  variant="outline"
                  className="w-full border-white/15 bg-slate-950 text-white hover:bg-slate-900"
                  onClick={async () => {
                    await post("/api/auth/logout", {}).catch(() => undefined);
                    onGoAuth();
                  }}
                >
                  Switch account
                </Button>
              </div>
            )
          ) : (
            <Button onClick={onGoAuth} className="mt-4 w-full bg-emerald-500 text-slate-950 hover:bg-emerald-400">
              Sign in / register to accept
            </Button>
          )}
        </>
      )}
    </Shell>
  );
}
