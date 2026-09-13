import { auth, signIn } from "@/auth";
import { redirect } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { OAuthButtons } from "@/components/oauth-buttons";
import { LogoWordmark } from "@/components/logo-mark";

export default async function LoginPage({ searchParams }: { searchParams: { callbackUrl?: string; error?: string } }) {
  const session = await auth();
  if (session) redirect("/dashboard");

  const callbackUrl = searchParams.callbackUrl ?? "/dashboard";

  return (
    <div className="flex min-h-screen items-center justify-center px-6">
      <Card className="w-full max-w-sm">
        <CardContent className="pt-6">
          <Link href="/">
            <LogoWordmark size={28} />
          </Link>
          <h1 className="mt-5 text-xl font-semibold">Sign in to TaskFlow</h1>
          <p className="mt-1 text-sm text-muted-foreground">Access your dashboard, API keys, and usage.</p>

          {searchParams.error && (
            <p className="mt-4 rounded-md bg-danger/10 border border-danger/30 px-3 py-2 text-sm text-danger">
              Sign-in failed. Check your details and try again.
            </p>
          )}

          <div className="mt-6">
            <OAuthButtons callbackUrl={callbackUrl} />
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
