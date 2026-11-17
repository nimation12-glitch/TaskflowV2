import { auth } from "@/auth";
import { redirect } from "next/navigation";
import { isPlatformAdmin, getBanState } from "@/lib/platform-admin";
import { AppShellClient } from "@/components/dashboard/app-shell-client";
import { BannedScreen } from "@/components/banned-screen";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  if (!session) redirect("/login");
  const admin = await isPlatformAdmin(session.user?.id);

  // Banned accounts bounce out of the entire app here — including accounts
  // banned mid-session, since this runs on every (app) page render.
  const ban = await getBanState(session.user?.id);
  if (ban.banned) return <BannedScreen reason={ban.reason} />;

  return (
    <AppShellClient admin={admin} email={session.user?.email ?? "—"} role={session.activeRole}>
      {children}
    </AppShellClient>
  );
}
