import { auth } from "@/auth";
import { redirect } from "next/navigation";
import { acceptInvitation } from "@/lib/backend-internal";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import Link from "next/link";

export default async function AcceptInvitePage({ params }: { params: { token: string } }) {
  const session = await auth();
  if (!session?.user?.id || !session.user.email) {
    redirect(`/login?callbackUrl=/invite/${params.token}`);
  }

  let error: string | null = null;
  try {
    await acceptInvitation({ token: params.token, userId: session.user.id, email: session.user.email });
  } catch (e) {
    error = e instanceof Error ? e.message : "Could not accept this invitation.";
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-6">
      <Card className="w-full max-w-sm">
        <CardContent className="pt-6 text-center">
          {error ? (
            <>
              <p className="font-medium">This invitation couldn't be accepted.</p>
              <p className="mt-2 text-sm text-muted-foreground">{error}</p>
            </>
          ) : (
            <p className="font-medium">You've joined the workspace.</p>
          )}
          <Link href="/dashboard" className="mt-4 block">
            <Button className="w-full">Go to dashboard</Button>
          </Link>
        </CardContent>
      </Card>
    </div>
  );
}
