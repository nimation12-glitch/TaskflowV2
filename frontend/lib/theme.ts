import "server-only";
import { cache } from "react";
import { prisma } from "@/lib/prisma";

export type ThemePreference = "light" | "dark" | "system";

export const getThemePreference = cache(async (userId: string | undefined | null): Promise<ThemePreference> => {
  if (!userId) return "system";
  try {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { themePreference: true } });
    const pref = user?.themePreference;
    return pref === "light" || pref === "dark" ? pref : "system";
  } catch (err) {
    // Fail safe to the default theme: this runs in the root layout, above
    // every error boundary in the app (see app/global-error.tsx for the
    // last-resort net if something here ever throws anyway) — a DB hiccup
    // or pending migration must never take down every page on the site
    // over a cosmetic preference.
    console.error("[taskflow] getThemePreference failed — defaulting to 'system':", err);
    return "system";
  }
});