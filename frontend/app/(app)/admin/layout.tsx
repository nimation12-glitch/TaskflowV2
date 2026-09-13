import { notFound } from "next/navigation";
import { auth } from "@/auth";
import { isPlatformAdmin } from "@/lib/platform-admin";
import { AdminSubNav } from "./admin-sub-nav";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  const admin = await isPlatformAdmin(session?.user?.id);
  // notFound() rather than a redirect — non-admins get a plain 404, not a
  // page that reveals "an admin panel exists here but you're not allowed in".
  if (!admin) notFound();

  return (
    <div>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Admin</h1>
        <p className="mt-1.5 text-sm text-muted-foreground">Platform-admin tools. Visible only to you.</p>
      </div>

      <div className="mt-6">
        <AdminSubNav />
      </div>

      <div className="mt-6">{children}</div>
    </div>
  );
}
