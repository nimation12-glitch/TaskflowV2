import Link from "next/link";
import { auth } from "@/auth";
import { redirect } from "next/navigation";
import { Sidebar } from "@/components/dashboard/sidebar";
import { UserMenu } from "@/components/dashboard/user-menu";
import { MobileNav } from "@/components/dashboard/mobile-nav";
import { isPlatformAdmin } from "@/lib/platform-admin";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  if (!session) redirect("/login");
  const admin = await isPlatformAdmin(session.user?.id);

  return (
    <div className="min-h-screen lg:flex">
      {/* Desktop sidebar */}
      <aside className="hidden w-60 shrink-0 flex-col border-r border-border bg-card/30 p-4 lg:flex">
        <Link href="/" className="flex items-center gap-2 px-2 text-[15px] font-semibold tracking-tight">
          <span className="flex h-6 w-6 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <span className="h-2 w-2 rounded-sm bg-current" />
          </span>
          TaskFlow
        </Link>
        <Sidebar admin={admin} />
        <div className="mt-auto border-t border-border pt-3">
          <UserMenu email={session.user?.email ?? "—"} role={session.activeRole} />
        </div>
      </aside>

      {/* Mobile top bar */}
      <header className="sticky top-0 z-30 flex items-center justify-between border-b border-border bg-background/95 px-4 py-3 backdrop-blur-sm lg:hidden">
        <Link href="/" className="flex items-center gap-2 text-[15px] font-semibold tracking-tight">
          <span className="flex h-6 w-6 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <span className="h-2 w-2 rounded-sm bg-current" />
          </span>
          TaskFlow
        </Link>
        <MobileNav admin={admin} email={session.user?.email ?? "—"} role={session.activeRole} />
      </header>

      <main className="min-w-0 flex-1 p-4 sm:p-6 lg:p-8">{children}</main>
    </div>
  );
}
