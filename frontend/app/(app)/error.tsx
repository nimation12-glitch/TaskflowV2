"use client";

import { useEffect } from "react";
import { signOut } from "next-auth/react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

export default function DashboardError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error("[taskflow] dashboard error boundary caught:", error);
  }, [error]);

  return (
    <div className="flex min-h-screen items-center justify-center px-6">
      <Card className="w-full max-w-md">
        <CardContent className="pt-6 text-center">
          <p className="font-medium">We couldn't load your workspace.</p>
          <p className="mt-2 text-sm text-muted-foreground">
            This is usually temporary — the backend may have been waking up from idle. Try again, and if it keeps
            happening, signing out and back in will refresh your session.
          </p>
          <div className="mt-6 flex flex-col gap-2">
            <Button onClick={() => reset()} className="w-full">
              Try again
            </Button>
            <Button variant="secondary" onClick={() => signOut({ redirectTo: "/login" })} className="w-full">
              Sign out and sign in again
            </Button>
          </div>
          {error.digest && <p className="mt-4 text-xs text-muted-foreground">Reference: {error.digest}</p>}
        </CardContent>
      </Card>
    </div>
  );
}