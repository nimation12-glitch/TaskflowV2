import { AlertTriangle } from "lucide-react";

export function UnavailableNotice({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-warning">
      <AlertTriangle className="h-4 w-4 shrink-0" />
      {label} isn't available right now — this usually clears up on its own. The rest of the page still works.
    </div>
  );
}