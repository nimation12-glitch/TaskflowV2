"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { signIn } from "next-auth/react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { LogoWordmark } from "@/components/logo-mark";
import { GoogleIcon, MicrosoftIcon, GitHubIcon } from "@/components/oauth-icons";

export default function SignupPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [agreed, setAgreed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!agreed) {
      setError("You need to agree to the Terms of Service and Privacy Policy to continue.");
      return;
    }
    setError(null);
    setLoading(true);
    try {
      const res = await fetch("/api/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, email, password }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error ?? "Could not create your account.");
        return;
      }
      const signInResult = await signIn("credentials", { email, password, redirect: false });
      if (signInResult?.error) {
        setError("Account created — please sign in.");
        router.push("/login");
        return;
      }
      router.push("/dashboard");
    } finally {
      setLoading(false);
    }
  }

  async function handleOAuth(provider: string) {
    if (!agreed) {
      setError("You need to agree to the Terms of Service and Privacy Policy to continue.");
      return;
    }
    setError(null);
    await signIn(provider, { redirectTo: "/dashboard" });
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-6 py-12">
      <Card className="w-full max-w-sm">
        <CardContent className="pt-6">
          <Link href="/">
            <LogoWordmark size={28} />
          </Link>
          <h1 className="mt-5 text-xl font-semibold">Create your TaskFlow account</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            You'll get a free workspace with pay-as-you-go GPU rental to start.
          </p>

          {error && <p className="mt-4 rounded-md bg-danger/10 border border-danger/30 px-3 py-2 text-sm text-danger">{error}</p>}

          <div className="mt-6 space-y-2">
            <Button type="button" variant="secondary" className="w-full justify-start gap-3" onClick={() => handleOAuth("google")}>
              <GoogleIcon />
              Continue with Google
            </Button>
            <Button
              type="button"
              variant="secondary"
              className="w-full justify-start gap-3"
              onClick={() => handleOAuth("microsoft-entra-id")}
            >
              <MicrosoftIcon />
              Continue with Microsoft
            </Button>
            <Button type="button" variant="secondary" className="w-full justify-start gap-3" onClick={() => handleOAuth("github")}>
              <GitHubIcon />
              Continue with GitHub
            </Button>
          </div>

          <div className="my-6 flex items-center gap-3 text-xs text-muted-foreground">
            <div className="h-px flex-1 bg-border" />
            or
            <div className="h-px flex-1 bg-border" />
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="name">Name</Label>
              <Input id="name" required value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="email">Email</Label>
              <Input id="email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                required
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">At least 8 characters.</p>
            </div>

            <label className="flex items-start gap-2.5 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={agreed}
                onChange={(e) => setAgreed(e.target.checked)}
                className="mt-0.5 h-3.5 w-3.5 rounded border-border accent-primary"
              />
              <span>
                I agree to the{" "}
                <Link href="/terms" target="_blank" className="text-foreground underline">
                  Terms of Service
                </Link>{" "}
                and{" "}
                <Link href="/privacy" target="_blank" className="text-foreground underline">
                  Privacy Policy
                </Link>
                .
              </span>
            </label>

            <Button type="submit" disabled={loading || !agreed} className="w-full">
              {loading ? "Creating account…" : "Create account"}
            </Button>
          </form>

          <p className="mt-6 text-center text-sm text-muted-foreground">
            Already have an account?{" "}
            <Link href="/login" className="text-foreground underline">
              Sign in
            </Link>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
