import { redirect } from "next/navigation";

// The AI Model Gateway (and the API keys used to call it) is paused as part of the
// GPU-rental pivot — see app/dashboard/models/page.tsx. Keeping this route alive as a
// redirect rather than deleting it, so old bookmarks/links don't dead-end.
export default function ApiKeysPage() {
  redirect("/dashboard/models");
}
