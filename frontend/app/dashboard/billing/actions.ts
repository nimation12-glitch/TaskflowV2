"use server";

import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { backendJson } from "@/lib/backend-client";

export async function checkoutSubscriptionAction(plan: "PRO" | "MAX") {
  const session = await auth();
  if (!session?.user?.email) throw new Error("Not signed in");
  const { checkout_url } = await backendJson<{ checkout_url: string }>("/billing/checkout/subscription", {
    method: "POST",
    body: JSON.stringify({ plan, email: session.user.email }),
  });
  redirect(checkout_url);
}

export async function checkoutCreditsAction(amountMicros: number) {
  const session = await auth();
  if (!session?.user?.email) throw new Error("Not signed in");
  const { checkout_url } = await backendJson<{ checkout_url: string }>("/billing/checkout/credits", {
    method: "POST",
    body: JSON.stringify({ amount_micros: amountMicros, email: session.user.email }),
  });
  redirect(checkout_url);
}

export async function openBillingPortalAction() {
  const { portal_url } = await backendJson<{ portal_url: string }>("/billing/portal", { method: "POST" });
  redirect(portal_url);
}
