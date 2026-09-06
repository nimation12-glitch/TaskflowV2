import { redirect } from "next/navigation";

// Usage/spend analytics were entirely AI-token-billing focused. That billing model is
// paused along with the AI Model Gateway — see app/dashboard/models/page.tsx. Rental
// cost accrual now lives directly on each rental card in /dashboard/compute.
export default function UsagePage() {
  redirect("/dashboard/models");
}
