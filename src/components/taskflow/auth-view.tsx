"use client";

/**
 * Auth view — sign in / sign up (email+password) and REAL OAuth buttons
 * (Phase 1 §5, §30, §31). Provider buttons render only the truth:
 * configured → enabled; missing credentials → disabled with a configuration
 * hint. No simulated OAuth anywhere (§4, §46). Includes the forgot-password
 * flow with a uniform, non-enumerating response.
 */

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Zap, Loader2, ArrowLeft, Info } from "lucide-react";
import { post, api, ApiError, startOAuth } from "@/lib/client-api";
import { DevOutboxHelper } from "@/components/taskflow/dev-outbox-helper";
import { toast } from "@/hooks/use-toast";

type Mode = "signin" | "signup" | "forgot";

type ProvidersState = {
  google: { enabled: boolean };
  microsoft: { enabled: boolean };
  github: { enabled: boolean };
};

const PROVIDER_LABELS: Record<string, string> = {
  google: "Google",
  microsoft: "Microsoft",
  github: "GitHub",
};

function OAuthButton({ provider, enabled, onGo }: { provider: string; enabled: boolean; onGo: (p: string) => void }) {
  return (
    <Button
      type="button"
      variant="outline"
      disabled={!enabled}
      title={enabled ? `Continue with ${PROVIDER_LABELS[provider]}` : `${PROVIDER_LABELS[provider]} sign-in is not configured on this deployment (missing ${provider.toUpperCase()}_CLIENT_ID / SECRET)`}
      onClick={() => onGo(provider)}
      className="w-full justify-start border-white/15 bg-slate-950 text-white hover:bg-slate-900 hover:text-white disabled:cursor-not-allowed disabled:opacity-45"
    >
      <ProviderIcon provider={provider} />
      Continue with {PROVIDER_LABELS[provider]}
      {!enabled && <Info className="ml-auto h-3.5 w-3.5 text-slate-500" aria-label="not configured" />}
    </Button>
  );
}

function ProviderIcon({ provider }: { provider: string }) {
  const cls = "mr-2 h-4 w-4";
  if (provider === "google") {
    return (
      <svg className={cls} viewBox="0 0 24 24" aria-hidden="true">
        <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.27-4.74 3.27-8.1Z" />
        <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23Z" />
        <path fill="#FBBC05" d="M5.84 14.1a6.6 6.6 0 0 1 0-4.2V7.06H2.18a11 11 0 0 0 0 9.88l3.66-2.84Z" />
        <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15A11 11 0 0 0 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52Z" />
      </svg>
    );
  }
  if (provider === "microsoft") {
    return (
      <svg className={cls} viewBox="0 0 24 24" aria-hidden="true">
        <path fill="#F25022" d="M1 1h10.5v10.5H1Z" />
        <path fill="#7FBA00" d="M12.5 1H23v10.5H12.5Z" />
        <path fill="#00A4EF" d="M1 12.5h10.5V23H1Z" />
        <path fill="#FFB900" d="M12.5 12.5H23V23H12.5Z" />
      </svg>
    );
  }
  return (
    <svg className={cls} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.55 0-.27-.01-1.17-.02-2.12-3.2.7-3.88-1.36-3.88-1.36-.52-1.33-1.28-1.68-1.28-1.68-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.19 1.76 1.19 1.03 1.75 2.69 1.25 3.34.95.1-.74.4-1.25.72-1.54-2.55-.29-5.24-1.28-5.24-5.68 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11.1 11.1 0 0 1 5.79 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.24 2.76.12 3.05.74.81 1.18 1.83 1.18 3.09 0 4.41-2.69 5.38-5.26 5.66.41.36.78 1.06.78 2.14 0 1.55-.02 2.79-.02 3.17 0 .31.21.67.8.55A10.52 10.52 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5Z" />
    </svg>
  );
}

export function AuthView({ initialMode, onBack, onAuthed }: {
  initialMode: Mode;
  onBack: () => void;
  onAuthed: () => void;
}) {
  const [mode, setMode] = useState<Mode>(initialMode);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [providers, setProviders] = useState<ProvidersState | null>(null);

  useEffect(() => {
    api<{ providers: ProvidersState }>("/api/auth/providers")
      .then((r) => setProviders(r.providers))
      .catch(() => setProviders({ google: { enabled: false }, microsoft: { enabled: false }, github: { enabled: false } }));
  }, []);

  async function goOAuth(provider: string) {
    setError(null);
    try {
      // Auth.js flow: csrf → POST signin/:provider → navigate to the
      // provider's authorization URL. Unconfigured providers return an
      // explicit error from the server — never a fake flow.
      window.location.href = await startOAuth(provider);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start OAuth sign-in");
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (mode === "signup") {
        await post("/api/auth/register", { email, password, phone, name: name || undefined });
        toast({
          title: "Verify your email to continue",
          description: "We sent you a verification link. After that, verify your phone to activate your workspace.",
        });
      } else if (mode === "signin") {
        await post("/api/auth/login", { email, password });
        toast({ title: "Welcome back" });
      } else {
        await post("/api/auth/forgot-password", { email });
        setNotice("If an account exists for that address, a password reset link has been sent.");
        setBusy(false);
        return;
      }
      onAuthed();
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "Something went wrong";
      setError(message);
    } finally {
      setBusy(false);
    }
  }

  const anyProviderEnabled = providers ? Object.values(providers).some((p) => p.enabled) : false;

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-950 p-4">
      <div className="w-full max-w-md">
        <Button
          variant="ghost"
          size="sm"
          className="mb-4 text-slate-400 hover:text-white hover:bg-white/10"
          onClick={onBack}
        >
          <ArrowLeft className="mr-1.5 h-4 w-4" /> Back to site
        </Button>
        <Card className="border-white/10 bg-slate-900 text-slate-100">
          <CardHeader className="items-center text-center">
            <div className="mx-auto mb-2 flex h-11 w-11 items-center justify-center rounded-xl bg-emerald-500">
              <Zap className="h-5.5 w-5.5 text-slate-950" strokeWidth={2.5} />
            </div>
            <CardTitle className="text-xl">
              {mode === "signup" ? "Create your TaskFlow account" : mode === "signin" ? "Sign in to TaskFlow" : "Reset your password"}
            </CardTitle>
            <CardDescription className="text-slate-400">
              {mode === "signup"
                ? "Verify your email and phone, then start on the Free plan with £2 of monthly AI usage credits."
                : mode === "signin"
                  ? "Access your dashboard, keys, usage and billing."
                  : "We'll email you a single-use reset link."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {mode !== "forgot" && (
              <div className="mb-5 space-y-2">
                {providers && ["google", "microsoft", "github"].map((p) => (
                  <OAuthButton key={p} provider={p} enabled={providers[p as keyof ProvidersState].enabled} onGo={goOAuth} />
                ))}
                {providers && !anyProviderEnabled && (
                  <p className="rounded-md border border-white/10 bg-slate-950 px-3 py-2 text-xs text-slate-400">
                    Social sign-in is not configured on this deployment yet. Add the provider client IDs/secrets
                    (see <code>.env.example</code>) and register the callback URLs to enable it.
                  </p>
                )}
                <div className="flex items-center gap-3 py-1" role="separator">
                  <div className="h-px flex-1 bg-white/10" />
                  <span className="text-xs uppercase tracking-wider text-slate-500">or</span>
                  <div className="h-px flex-1 bg-white/10" />
                </div>
              </div>
            )}
            <form onSubmit={submit} className="space-y-4">
              {mode === "signup" && (
                <div className="space-y-2">
                  <Label htmlFor="name" className="text-slate-300">Name</Label>
                  <Input
                    id="name"
                    placeholder="John Carter"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    className="border-white/15 bg-slate-950 text-white placeholder:text-slate-600"
                    autoComplete="name"
                  />
                </div>
              )}
              <div className="space-y-2">
                <Label htmlFor="email" className="text-slate-300">Email</Label>
                <Input
                  id="email"
                  type="email"
                  required
                  placeholder="you@company.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="border-white/15 bg-slate-950 text-white placeholder:text-slate-600"
                  autoComplete="email"
                />
              </div>
              {mode !== "forgot" && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label htmlFor="password" className="text-slate-300">Password</Label>
                    {mode === "signin" && (
                      <button
                        type="button"
                        className="text-xs text-emerald-400 hover:text-emerald-300"
                        onClick={() => { setMode("forgot"); setError(null); }}
                      >
                        Forgot password?
                      </button>
                    )}
                  </div>
                  <Input
                    id="password"
                    type="password"
                    required
                    placeholder={mode === "signup" ? "At least 8 characters, letters + numbers" : "Your password"}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="border-white/15 bg-slate-950 text-white placeholder:text-slate-600"
                    autoComplete={mode === "signup" ? "new-password" : "current-password"}
                  />
                </div>
              )}
              {mode === "signup" && (
                <div className="space-y-2">
                  <Label htmlFor="phone" className="text-slate-300">Phone number</Label>
                  <Input
                    id="phone"
                    type="tel"
                    required
                    placeholder="+44 7700 900123"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    className="border-white/15 bg-slate-950 text-white placeholder:text-slate-600"
                    autoComplete="tel"
                  />
                  <p className="text-xs text-slate-500">
                    Verified by SMS before your workspace activates — this protects every TaskFlow account from abuse.
                  </p>
                </div>
              )}
              {error && (
                <p className="rounded-md border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-300">
                  {error}
                </p>
              )}
              {notice && (
                <p className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300">
                  {notice}
                </p>
              )}
              {mode === "forgot" && notice && (
                <DevOutboxHelper kind="email" to={email} />
              )}
              <Button
                type="submit"
                disabled={busy}
                className="w-full bg-emerald-500 text-slate-950 hover:bg-emerald-400"
              >
                {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {mode === "signup" ? "Create account" : mode === "signin" ? "Sign in" : "Send reset link"}
              </Button>
            </form>
            <p className="mt-4 text-center text-sm text-slate-400">
              {mode === "forgot" ? (
                <button
                  type="button"
                  className="font-medium text-emerald-400 hover:text-emerald-300"
                  onClick={() => { setMode("signin"); setNotice(null); setError(null); }}
                >
                  Back to sign in
                </button>
              ) : (
                <>
                  {mode === "signup" ? "Already have an account?" : "New to TaskFlow?"}{" "}
                  <button
                    type="button"
                    className="font-medium text-emerald-400 hover:text-emerald-300"
                    onClick={() => { setMode(mode === "signup" ? "signin" : "signup"); setError(null); }}
                  >
                    {mode === "signup" ? "Sign in" : "Create one free"}
                  </button>
                </>
              )}
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
