import { auth, signIn } from "@/auth";
import { redirect } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";

const OAUTH_BUTTONS = [
  { id: "google", label: "Continue with Google", envFlag: "GOOGLE_CLIENT_ID" },
  { id: "microsoft-entra-id", label: "Continue with Microsoft", envFlag: "MICROSOFT_CLIENT_ID" },
  { id: "github", label: "Continue with GitHub", envFlag: "GITHUB_CLIENT_ID" },
] as const;

export default async function LoginPage({ searchParams }: { searchParams: { callbackUrl?: string; error?: string } }) {
  const session = await auth();
  if (session) redirect("/dashboard");

  const callbackUrl = searchParams.callbackUrl ?? "/dashboard";

  return (
    <div className="flex min-h-screen items-center justify-center px-6">
      <Card className="w-full max-w-sm">
        <CardContent className="pt-6">
          <h1 className="text-xl font-semibold">Sign in to TaskFlow</h1>
          <p className="mt-1 text-sm text-muted-foreground">Access your dashboard, API keys, and usage.</p>

          {searchParams.error && (
            <p className="mt-4 rounded-md bg-danger/10 border border-danger/30 px-3 py-2 text-sm text-danger">
              Sign-in failed. Check your details and try again.
            </p>
          )}

          <div className="mt-6 space-y-2">
            {OAUTH_BUTTONS.map((btn) => {
              const configured = Boolean(process.env[btn.envFlag]);
              return (
                <form
                  key={btn.id}
                  action={async () => {
                    "use server";
                    await signIn(btn.id, { redirectTo: callbackUrl });
                  }}
                >
                  <Button
                    type="submit"
                    variant="secondary"
                    className="w-full"
                    disabled={!configured}
                    title={configured ? undefined : "This sign-in method is not configured yet"}
                  >
                    {btn.label}
                    {!configured && <span className="text-xs text-muted-foreground"> (not configured)</span>}
                  </Button>
                </form>
              );
            })}
          </div>

          <div className="my-6 flex items-center gap-3 text-xs text-muted-foreground">
            <div className="h-px flex-1 bg-border" />
            or
            <div className="h-px flex-1 bg-border" />
          </div>

          <form
            action={async (formData: FormData) => {
              "use server";
              await signIn("credentials", {
                email: formData.get("email"),
                password: formData.get("password"),
                redirectTo: callbackUrl,
              });
            }}
            className="space-y-4"
          >
            <div className="space-y-1.5">
              <Label htmlFor="email">Email</Label>
              <Input id="email" name="email" type="email" required autoComplete="email" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="password">Password</Label>
              <Input id="password" name="password" type="password" required autoComplete="current-password" />
            </div>
            <Button type="submit" className="w-full">
              Sign in
            </Button>
          </form>

          <p className="mt-6 text-center text-sm text-muted-foreground">
            <Link href="/forgot-password" className="hover:text-foreground">
              Forgot password?
            </Link>
          </p>
          <p className="mt-2 text-center text-sm text-muted-foreground">
            No account?{" "}
            <Link href="/signup" className="text-foreground underline">
              Sign up
            </Link>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
