import { signOut } from "@/auth";
import { Button } from "@/components/ui/button";
import { LogoMark } from "@/components/logo-mark";
import { ShieldBan } from "lucide-react";

/**
 * Rendered by the (app) layout in place of the entire app when the signed-in
 * account is banned. Their session is still technically valid until it
 * expires, so this screen lets them sign out explicitly — but nothing inside
 * the app is reachable while the ban stands.
 */
export async function BannedScreen({ reason }: { reason: string | null }) {
  return (
    <div className="flex min-h-screen items-center justify-center px-6">
      <div className="w-full max-w-sm text-center">
        <div className="flex justify-center">
          <LogoMark size={32} />
        </div>
        <div className="mt-6 flex justify-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-danger/10">
            <ShieldBan className="h-6 w-6 text-danger" strokeWidth={1.75} />
          </div>
        </div>
        <h1 className="mt-4 text-xl font-semibold">Account suspended</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {reason
            ? `Your account has been suspended. ${reason}`
            : "Your account has been suspended by a platform administrator."}
        </p>
        <p className="mt-1.5 text-xs text-muted-foreground">
          Think this is a mistake? Contact support@taskflow.web-agent.org.
        </p>
        <form
          action={async () => {
            "use server";
            await signOut({ redirectTo: "/login?error=AccountBanned" });
          }}
          className="mt-6"
        >
          <Button variant="secondary" className="w-full">
            Sign out
          </Button>
        </form>
      </div>
    </div>
  );
}
