import "server-only";
import { cache } from "react";
import { prisma } from "@/lib/prisma";

export type ThemePreference = "light" | "dark" | "system";

export const getThemePreference = cache(async (userId: string | undefined | null): Promise<ThemePreference> => {
  if (!userId) return "system";
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { themePreference: true } });
  const pref = user?.themePreference;
  return pref === "light" || pref === "dark" ? pref : "system";
});
