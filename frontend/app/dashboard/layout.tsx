import Link from "next/link";
import { auth } from "@/auth";
import { redirect } from "next/navigation";
import { Sidebar } from "@/components/dashboard/sidebar";
import { UserMenu } from "@/components/dashboard/user-menu";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  if (!session) redirect("/login");

  return (
    <div className="flex min-h-screen">
      <aside className="flex w-60 shrink-0 flex-col border-r border-border p-4">
        <Link href="/" className="flex items-center gap-2 px-2 text-[15px] font-semibold tracking-tight">
          <span className="flex h-6 w-6 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <span className="h-2 w-2 rounded-sm bg-current" />
          </span>
          TaskFlow
        </Link>
        <Sidebar />
        <div className="mt-auto border-t border-border pt-3">
          <UserMenu email={session.user?.email ?? "—"} role={session.activeRole} />
        </div>
      </aside>
      <main className="flex-1 p-8">{children}</main>
    </div>
  );
}
