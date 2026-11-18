import { redirect } from "next/navigation";

// Workspaces merged into the Compute page (Catalogue / Workspaces / SSH keys
// tabs) — old links keep working by forwarding to the Workspaces tab.
export default function WorkspacesPage() {
  redirect("/compute?tab=workspaces");
}
