import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import { headers } from "next/headers";
import "./globals.css";
import { SessionProvider } from "@/components/session-provider";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/toaster";
import { MaintenanceSplash } from "@/components/maintenance-splash";
import { getSystemStatus } from "@/lib/system-client";
import { isMaintenanceExempt } from "@/lib/maintenance-exempt-paths";
import { isPlatformAdmin } from "@/lib/platform-admin";
import { auth } from "@/auth";

const inter = Inter({ subsets: ["latin"], variable: "--font-sans" });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono" });

export const metadata: Metadata = {
  title: "TaskFlow — Dedicated GPU rental",
  description: "Rent dedicated GPUs by the hour or book them upfront — without the infrastructure complexity.",
};

async function shouldShowMaintenanceSplash(): Promise<{ show: boolean; message: string | null }> {
  const pathname = headers().get("x-pathname") ?? "";
  if (isMaintenanceExempt(pathname)) return { show: false, message: null };

  let status;
  try {
    status = await getSystemStatus();
  } catch (err) {
    // Fail OPEN: a transient error reaching /system/status shouldn't take
    // the entire site down. Log it so it's visible, but let the app render.
    console.error("[taskflow] getSystemStatus failed — rendering normally:", err);
    return { show: false, message: null };
  }

  if (!status.maintenance_mode_enabled) return { show: false, message: null };

  const session = await auth();
  const admin = await isPlatformAdmin(session?.user?.id);
  // Admins render the app normally (their /compute/* calls succeed server-side;
  // /v1/* calls still 503 — there's no admin exception on that route).
  return { show: !admin, message: status.maintenance_message };
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const { show, message } = await shouldShowMaintenanceSplash();

  return (
    <html lang="en" className={`${inter.variable} ${mono.variable}`}>
      <body className="font-sans antialiased">
        {show ? (
          <MaintenanceSplash message={message} />
        ) : (
          <SessionProvider>
            <TooltipProvider delayDuration={200}>{children}</TooltipProvider>
          </SessionProvider>
        )}
        <Toaster />
      </body>
    </html>
  );
}
