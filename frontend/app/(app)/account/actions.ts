"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import type { ThemePreference } from "@/lib/theme";

export async function setThemePreferenceAction(preference: ThemePreference) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not signed in");
  await prisma.user.update({ where: { id: session.user.id }, data: { themePreference: preference } });
  // The theme class is applied in the root layout, so revalidate broadly.
  revalidatePath("/", "layout");
}

export async function updateNameAction(name: string) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not signed in");
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Name can't be empty");
  await prisma.user.update({ where: { id: session.user.id }, data: { name: trimmed } });
  revalidatePath("/account");
  revalidatePath("/", "layout");
}
