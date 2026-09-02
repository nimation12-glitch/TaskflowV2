"use client";

/**
 * Account view — profile, email + phone verification, connected providers,
 * password management, sessions and sign-out (Phase 1 §28; correction spec
 * §3, §18). Provider tokens are never displayed (they are never stored — §6);
 * sessions never expose token hashes; full phone numbers are never rendered
 * beyond what the user typed themselves.
 */

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, MailCheck, MailX, Link2, Unlink, Trash2, ShieldCheck, Smartphone, BadgeCheck } from "lucide-react";
import { api, post, ApiError, startOAuth } from "@/lib/client-api";
import { useToast } from "@/hooks/use-toast";
import type { MeResponse } from "@/types/taskflow";

type SessionsResponse = {
  currentSessionId: string;
  sessions: Array<{
    id: string;
    createdAt: string;
    lastUsedAt: string;
    ipAddress: string | null;
    deviceHint: string;
    isCurrent: boolean;
  }>;
};

const PROVIDER_LABELS: Record<string, string> = { google: "Google", microsoft: "Microsoft", github: "GitHub" };

export function AccountView({ me, refreshMe, onLogout }: { me: MeResponse; refreshMe: () => Promise<boolean>; onLogout: () => void }) {
  const { toast } = useToast();
  const [sessions, setSessions] = useState<SessionsResponse | null>(null);
  const [currentPw, setCurrentPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [changing, setChanging] = useState(false);
  // Phone (re)verification state (§3/§18).
  const [phoneInput, setPhoneInput] = useState("");
  const [phoneCode, setPhoneCode] = useState("");
  const [phoneCodeSent, setPhoneCodeSent] = useState(false);
  const [phoneBusy, setPhoneBusy] = useState(false);

  const loadSessions = useCallback(async () => {
    try {
      setSessions(await api<SessionsResponse>("/api/auth/sessions"));
    } catch {
      /* non-fatal */
    }
  }, []);

  useEffect(() => {
    loadSessions();
  }, [loadSessions]);

  async function resendVerification() {
    try {
      await post("/api/auth/resend-verification", {});
      toast({ title: "Verification email sent", description: "Check your inbox (or the dev outbox in local development)." });
    } catch (err) {
      toast({ title: err instanceof ApiError ? err.message : "Could not send", variant: "destructive" });
    }
  }

  async function connectProvider(provider: string) {
    try {
      // Auth.js link flow: the session cookie makes the callback connect the
      // identity to THIS account; policy.ts refuses clashes/unverified claims.
      window.location.href = await startOAuth(provider, "link");
    } catch (err) {
      toast({ title: err instanceof Error ? err.message : "Could not start the connection", variant: "destructive" });
    }
  }

  async function disconnectProvider(identityId: string, provider: string) {
    try {
      await post(`/api/auth/oauth/${provider}/unlink`, { identityId });
      toast({ title: "Provider disconnected" });
      await refreshMe();
    } catch (err) {
      toast({ title: err instanceof ApiError ? err.message : "Failed", variant: "destructive" });
    }
  }

  async function changePassword(e: React.FormEvent) {
    e.preventDefault();
    setChanging(true);
    try {
      await post("/api/auth/password/change", { currentPassword: currentPw, newPassword: newPw });
      toast({ title: "Password changed", description: "Other sessions were signed out." });
      setCurrentPw("");
      setNewPw("");
      await loadSessions();
    } catch (err) {
      toast({ title: err instanceof ApiError ? err.message : "Change failed", variant: "destructive" });
    } finally {
      setChanging(false);
    }
  }

  async function revokeSession(id: string) {
    try {
      await api(`/api/auth/sessions/${id}`, { method: "DELETE" });
      await loadSessions();
      toast({ title: "Session revoked" });
    } catch (err) {
      toast({ title: err instanceof ApiError ? err.message : "Failed", variant: "destructive" });
    }
  }

  async function revokeAll() {
    try {
      await api("/api/auth/sessions/all", { method: "DELETE" });
      await loadSessions();
      toast({ title: "All other sessions revoked" });
    } catch (err) {
      toast({ title: err instanceof ApiError ? err.message : "Failed", variant: "destructive" });
    }
  }

  async function requestPhoneCode() {
    setPhoneBusy(true);
    try {
      const res = await post<{ sent: boolean; smsAccepted?: boolean; error?: string }>('/api/auth/phone/request', phoneInput ? { phone: phoneInput } : {});
      if (res.sent && res.smsAccepted !== false) {
        setPhoneCodeSent(true);
        toast({ title: "Verification code sent", description: "Check your phone for the 6-digit code." });
      } else {
        toast({ title: res.error ?? "SMS delivery failed", description: "SMS may not be configured on this deployment.", variant: "destructive" });
      }
    } catch (err) {
      toast({ title: err instanceof ApiError ? err.message : "Could not send the code", variant: "destructive" });
    } finally {
      setPhoneBusy(false);
    }
  }

  async function confirmPhoneCode(e: React.FormEvent) {
    e.preventDefault();
    setPhoneBusy(true);
    try {
      await post('/api/auth/phone/confirm', { code: phoneCode });
      setPhoneCode("");
      setPhoneCodeSent(false);
      setPhoneInput("");
      toast({ title: "Phone verified" });
      await refreshMe();
    } catch (err) {
      toast({ title: err instanceof ApiError ? err.message : "Verification failed", variant: "destructive" });
    } finally {
      setPhoneBusy(false);
    }
  }

  const connectedProviderNames = new Set(me.providers.map((p) => p.provider));
  const hasPassword = true; // display-only hint is derived below from providers count + notice

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Profile</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-4">
            <span className="flex h-14 w-14 items-center justify-center rounded-full bg-emerald-600 text-xl font-bold text-white">
              {(me.user?.name ?? me.user?.email ?? "?").slice(0, 1).toUpperCase()}
            </span>
            <div>
              <div className="text-lg font-semibold text-slate-900">{me.user?.name ?? "—"}</div>
              <div className="flex items-center gap-2 text-sm text-slate-500">
                {me.user?.email}
                {me.user?.emailVerified ? (
                  <Badge variant="outline" className="border-emerald-300 bg-emerald-50 text-emerald-700">
                    <MailCheck className="mr-1 h-3 w-3" /> Verified
                  </Badge>
                ) : (
                  <button onClick={resendVerification} className="inline-flex items-center gap-1 rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700 hover:bg-amber-100">
                    <MailX className="h-3 w-3" /> Unverified — resend link
                  </button>
                )}
              </div>
            </div>
          </div>
          <div className="grid gap-2 text-sm text-slate-500 sm:grid-cols-2">
            <div>User ID: <code className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600">{me.user?.id}</code></div>
            <div>Member since: {me.user && new Date(me.user.createdAt).toLocaleDateString()}</div>
          </div>
          <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3 text-sm text-slate-500">
            <Smartphone className="h-4 w-4 text-slate-400" />
            Phone:
            {me.user?.phoneVerified ? (
              <>
                <span className="font-medium text-slate-700">{me.user.phone ?? "—"}</span>
                <Badge variant="outline" className="border-emerald-300 bg-emerald-50 text-emerald-700">
                  <BadgeCheck className="mr-1 h-3 w-3" /> Verified
                </Badge>
              </>
            ) : (
              <Badge variant="outline" className="border-amber-300 bg-amber-50 text-amber-700">Not verified</Badge>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Phone verification</CardTitle>
          <CardDescription>
            Verify a phone number by SMS to secure the account (required for password accounts before activation; optional but recommended for social sign-in).
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={confirmPhoneCode} className="max-w-md space-y-4">
            <div className="space-y-2">
              <Label htmlFor="account-phone">Phone number</Label>
              <div className="flex gap-2">
                <Input
                  id="account-phone"
                  type="tel"
                  placeholder={me.user?.phone ?? "+44 7700 900123"}
                  value={phoneInput}
                  onChange={(e) => setPhoneInput(e.target.value)}
                  disabled={phoneCodeSent}
                  autoComplete="tel"
                />
                <Button type="button" variant="outline" onClick={requestPhoneCode} disabled={phoneBusy || phoneCodeSent} className="border-slate-300">
                  {phoneBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Send code"}
                </Button>
              </div>
            </div>
            {phoneCodeSent && (
              <div className="space-y-2">
                <Label htmlFor="account-phone-code">6-digit code</Label>
                <div className="flex gap-2">
                  <Input
                    id="account-phone-code"
                    inputMode="numeric"
                    placeholder="123456"
                    value={phoneCode}
                    onChange={(e) => setPhoneCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                    autoComplete="one-time-code"
                    required
                  />
                  <Button type="submit" disabled={phoneBusy || phoneCode.length !== 6} className="bg-emerald-600 text-white hover:bg-emerald-500">
                    Verify
                  </Button>
                  <Button type="button" variant="ghost" onClick={() => { setPhoneCodeSent(false); setPhoneCode(""); }}>
                    Cancel
                  </Button>
                </div>
              </div>
            )}
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Connected providers</CardTitle>
          <CardDescription>
            Social sign-in methods linked to this account. Only provider identity identifiers are stored — never tokens.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {me.providers.length === 0 && (
            <p className="text-sm text-slate-500">No social providers connected yet.</p>
          )}
          {me.providers.map((p) => (
            <div key={p.id} className="flex items-center justify-between rounded-lg border border-slate-200 px-4 py-3">
              <div className="flex items-center gap-3">
                <Link2 className="h-4 w-4 text-slate-400" />
                <div>
                  <div className="text-sm font-medium text-slate-900">{PROVIDER_LABELS[p.provider] ?? p.provider}</div>
                  <div className="text-xs text-slate-500">{p.providerEmail ?? "email hidden by provider"}</div>
                </div>
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="text-rose-600 hover:bg-rose-50"
                onClick={() => disconnectProvider(p.id, p.provider)}
                title="Disconnect this provider"
              >
                <Unlink className="h-4 w-4" />
              </Button>
            </div>
          ))}
          <div className="flex flex-wrap gap-2 pt-1">
            {["google", "microsoft", "github"]
              .filter((p) => !connectedProviderNames.has(p))
              .map((p) => (
                <Button key={p} variant="outline" size="sm" onClick={() => connectProvider(p)} className="border-slate-300">
                  <Link2 className="mr-1.5 h-3.5 w-3.5" /> Connect {PROVIDER_LABELS[p]}
                </Button>
              ))}
          </div>
          {me.providers.length === 0 && hasPassword && (
            <p className="text-xs text-slate-400">Your password remains a sign-in method; disconnecting is blocked only when it would leave no way in.</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Password</CardTitle>
          <CardDescription>Changing your password signs out every other session.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={changePassword} className="max-w-md space-y-4">
            <div className="space-y-2">
              <Label htmlFor="current-pw">Current password</Label>
              <Input id="current-pw" type="password" value={currentPw} onChange={(e) => setCurrentPw(e.target.value)} autoComplete="current-password" required />
            </div>
            <div className="space-y-2">
              <Label htmlFor="new-pw">New password</Label>
              <Input id="new-pw" type="password" value={newPw} onChange={(e) => setNewPw(e.target.value)} autoComplete="new-password" placeholder="At least 8 characters, letters + numbers" required />
            </div>
            <Button type="submit" disabled={changing} className="bg-emerald-600 text-white hover:bg-emerald-500">
              {changing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />} Update password
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle className="text-base">Active sessions</CardTitle>
            <CardDescription>Sessions with access to this account.</CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={revokeAll}>
            <ShieldCheck className="mr-1.5 h-4 w-4" /> Revoke others
          </Button>
        </CardHeader>
        <CardContent>
          {!sessions ? (
            <Loader2 className="h-5 w-5 animate-spin text-slate-400" />
          ) : (
            <ul className="divide-y divide-slate-100">
              {sessions.sessions.map((s) => (
                <li key={s.id} className="flex items-center justify-between py-3">
                  <div>
                    <div className="text-sm font-medium text-slate-900">
                      {s.deviceHint} {s.isCurrent && <Badge variant="outline" className="ml-1 border-emerald-300 bg-emerald-50 text-emerald-700">this device</Badge>}
                    </div>
                    <div className="text-xs text-slate-500">
                      {s.ipAddress ?? "unknown IP"} · last used {new Date(s.lastUsedAt).toLocaleString()}
                    </div>
                  </div>
                  {!s.isCurrent && (
                    <Button variant="ghost" size="sm" className="text-rose-600 hover:bg-rose-50" onClick={() => revokeSession(s.id)}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card className="border-rose-200">
        <CardHeader>
          <CardTitle className="text-base text-rose-700">Sign out</CardTitle>
          <CardDescription>Ends this session. Your data and organization remain.</CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="outline" onClick={onLogout} className="border-rose-300 text-rose-700 hover:bg-rose-50">
            Sign out of TaskFlow
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
