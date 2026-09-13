import { signIn } from "@/auth";
import { Button } from "@/components/ui/button";
import { GoogleIcon, MicrosoftIcon, GitHubIcon } from "@/components/oauth-icons";

const OAUTH_BUTTONS = [
  { id: "google", label: "Continue with Google", envFlag: "GOOGLE_CLIENT_ID", Icon: GoogleIcon },
  { id: "microsoft-entra-id", label: "Continue with Microsoft", envFlag: "MICROSOFT_CLIENT_ID", Icon: MicrosoftIcon },
  { id: "github", label: "Continue with GitHub", envFlag: "GITHUB_CLIENT_ID", Icon: GitHubIcon },
] as const;

export function OAuthButtons({ callbackUrl }: { callbackUrl: string }) {
  return (
    <div className="space-y-2">
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
              className="w-full justify-start gap-3"
              disabled={!configured}
              title={configured ? undefined : "This sign-in method is not configured yet"}
            >
              <btn.Icon />
              {btn.label}
              {!configured && <span className="ml-auto text-xs text-muted-foreground">(not configured)</span>}
            </Button>
          </form>
        );
      })}
    </div>
  );
}
