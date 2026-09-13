import { auth } from "@/auth";
import { redirect } from "next/navigation";
import { isPlatformAdmin } from "@/lib/platform-admin";
import { AppShellClient } from "@/components/dashboard/app-shell-client";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  if (!session) redirect("/login");
  const admin = await isPlatformAdmin(session.user?.id);

  return (
    <AppShellClient admin={admin} email={session.user?.email ?? "—"} role={session.activeRole}>
      {children}
    </AppShellClient>
  );
}
