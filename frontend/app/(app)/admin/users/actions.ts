"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@/auth";
import { getSiteRole } from "@/lib/platform-admin";
import { prisma } from "@/lib/prisma";

/**
 * Every action re-verifies the caller's site role server-side — the client
 * only decides which buttons to render, never what is allowed.
 */

async function requireAdminCaller() {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not signed in");
  const siteRole = await getSiteRole(session.user.id);
  if (siteRole === "USER") throw new Error("Admin access required");
  return { callerId: session.user.id, siteRole };
}

async function targetFor(targetUserId: string) {
  const user = await prisma.user.findUnique({
    where: { id: targetUserId },
    select: { id: true, siteRole: true, bannedAt: true },
  });
  if (!user) throw new Error("User not found");
  return user;
}

export async function banUserAction(targetUserId: string) {
  const caller = await requireAdminCaller();
  if (targetUserId === caller.callerId) throw new Error("You cannot ban your own account");
  const target = await targetFor(targetUserId);
  if (target.siteRole === "OWNER") throw new Error("The platform owner cannot be banned");
  if (caller.siteRole !== "OWNER" && target.siteRole === "ADMIN") {
    throw new Error("Only the owner can ban another admin");
  }
  if (target.bannedAt) throw new Error("This account is already banned");

  await prisma.user.update({
    where: { id: targetUserId },
    data: { bannedAt: new Date(), bannedReason: null },
  });
  revalidatePath("/admin/users");
}

export async function unbanUserAction(targetUserId: string) {
  const caller = await requireAdminCaller();
  const target = await targetFor(targetUserId);
  if (caller.siteRole !== "OWNER" && target.siteRole === "ADMIN") {
    throw new Error("Only the owner can unban another admin");
  }
  if (!target.bannedAt) throw new Error("This account is not banned");

  await prisma.user.update({
    where: { id: targetUserId },
    data: { bannedAt: null, bannedReason: null },
  });
  revalidatePath("/admin/users");
}

export async function setSiteRoleAction(targetUserId: string, role: "ADMIN" | "USER") {
  const caller = await requireAdminCaller();
  if (caller.siteRole !== "OWNER") throw new Error("Only the platform owner can change site roles");
  if (targetUserId === caller.callerId) throw new Error("You cannot change your own role");
  const target = await targetFor(targetUserId);
  if (target.siteRole === "OWNER") throw new Error("The platform owner's role is fixed");

  await prisma.user.update({ where: { id: targetUserId }, data: { siteRole: role } });
  revalidatePath("/admin/users");
}
