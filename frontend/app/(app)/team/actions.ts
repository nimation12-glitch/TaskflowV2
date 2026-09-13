"use server";

import { revalidatePath } from "next/cache";
import { backendJson } from "@/lib/backend-client";
import { sendEmail } from "@/lib/email";

export async function inviteMemberAction(email: string, role: "ADMIN" | "MEMBER") {
  const result = await backendJson<{ id: string; invited_email: string; token: string }>("/team/invitations", {
    method: "POST",
    body: JSON.stringify({ email, role }),
  });

  const inviteUrl = `${process.env.NEXTAUTH_URL ?? "http://localhost:3000"}/invite/${result.token}`;
  await sendEmail({
    to: result.invited_email,
    subject: "You've been invited to join a TaskFlow workspace",
    html: `<p>You've been invited to join a TaskFlow workspace.</p><p><a href="${inviteUrl}">Accept invitation</a></p>`,
  });

  revalidatePath("/team");
}

export async function removeMemberAction(userId: string) {
  await backendJson(`/team/members/${userId}`, { method: "DELETE" });
  revalidatePath("/team");
}
