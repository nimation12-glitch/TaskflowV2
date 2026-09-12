"use client";

import { useState } from "react";
import { AlertTriangle, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, DialogClose } from "@/components/ui/dialog";
import { useAction } from "@/lib/hooks/use-action";
import { formatDateTime } from "@/lib/utils";
import { setMaintenanceModeAction } from "./actions";

export function MaintenanceControls({
  initialEnabled,
  initialMessage,
  updatedAt: initialUpdatedAt,
}: {
  initialEnabled: boolean;
  initialMessage: string | null;
  updatedAt: string | null;
}) {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [message, setMessage] = useState(initialMessage ?? "");
  const [updatedAt, setUpdatedAt] = useState(initialUpdatedAt);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const { pending, run } = useAction();

  function save(nextEnabled: boolean) {
    run(
      () => setMaintenanceModeAction(nextEnabled, message.trim() || null),
      {
        success: nextEnabled ? "Maintenance mode enabled" : "Maintenance mode disabled",
        error: "Couldn't update maintenance mode",
        onSuccess: (result) => {
          setEnabled(nextEnabled);
          setUpdatedAt(result.updated_at);
          setConfirmOpen(false);
        },
      }
    );
  }

  function handleToggle() {
    if (!enabled) {
      // Turning ON — this immediately blocks GPU rentals and the AI API for
      // every non-admin user, so it always goes through a confirm dialog.
      setConfirmOpen(true);
    } else {
      save(false);
    }
  }

  return (
    <div className="max-w-2xl space-y-6">
      <Card className={enabled ? "border-warning/40" : undefined}>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-foreground">Maintenance mode</CardTitle>
              <CardDescription>
                Blocks the AI API and GPU compute for everyone except admins. Non-admins see a full-page splash
                site-wide.
              </CardDescription>
            </div>
            <Badge variant={enabled ? "warning" : "success"}>{enabled ? "Enabled" : "Disabled"}</Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="flex items-center justify-between rounded-md border border-border p-4">
            <div>
              <p className="text-sm font-medium">{enabled ? "Currently blocking the app" : "App is running normally"}</p>
              {updatedAt && <p className="mt-0.5 text-xs text-muted-foreground">Last changed {formatDateTime(updatedAt)}</p>}
            </div>
            <button
              role="switch"
              aria-checked={enabled}
              onClick={handleToggle}
              disabled={pending}
              className={`relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-50 ${enabled ? "bg-warning" : "bg-muted"}`}
            >
              <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-transform ${enabled ? "translate-x-5" : "translate-x-0.5"}`} />
            </button>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="maintenance-message">Message shown to users</Label>
            <Textarea
              id="maintenance-message"
              rows={3}
              placeholder="We're making some changes behind the scenes. This shouldn't take long — check back shortly."
              value={message}
              onChange={(e) => setMessage(e.target.value)}
            />
            {enabled && (
              <Button size="sm" variant="secondary" loading={pending} onClick={() => save(true)}>
                Update message
              </Button>
            )}
          </div>

          <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
            <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            As an admin, your own GPU rental calls will keep working while this is on. The AI Model Gateway
            (<code className="rounded bg-muted px-1 py-0.5">/v1/*</code>) has no admin exception on the backend and
            will still return 503 for everyone, including you.
          </p>
        </CardContent>
      </Card>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-warning" />
              Enable maintenance mode?
            </DialogTitle>
            <DialogDescription asChild>
              <div>
                This immediately blocks GPU rentals and the AI API for every non-admin user, and shows them the
                message below instead of the app. Only turn this on if you mean to right now.
              </div>
            </DialogDescription>
          </DialogHeader>
          <div className="mt-3 rounded-md bg-muted/40 p-3 text-sm text-muted-foreground">
            {message.trim() || "No message set — users will see a generic notice."}
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="secondary">Cancel</Button>
            </DialogClose>
            <Button variant="danger" loading={pending} onClick={() => save(true)}>
              Enable maintenance mode
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
