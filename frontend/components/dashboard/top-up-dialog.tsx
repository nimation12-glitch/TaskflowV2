"use client";

import * as React from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
} from "@/components/ui/dialog";
import { useAction } from "@/lib/hooks/use-action";
import { topUpWalletAction } from "@/app/(app)/compute/actions";

export const TOP_UP_PACKAGES = [
  { label: "£10", amountMicros: 10_000_000 },
  { label: "£25", amountMicros: 25_000_000 },
  { label: "£50", amountMicros: 50_000_000 },
  { label: "£100", amountMicros: 100_000_000 },
];

/**
 * The one place the wallet top-up flow lives. Used by the wallet widget and
 * by the GPU picker when a balance is too low to cover a launch reserve —
 * both need the same packages and the same checkout flow.
 */
export function TopUpDialog({
  trigger,
  title = "Top up your GPU wallet",
  description = "Choose an amount — you'll pay in Taskflow's secure checkout.",
  className,
}: {
  trigger?: React.ReactNode;
  title?: string;
  description?: string;
  className?: string;
}) {
  const { pending, run } = useAction();

  return (
    <Dialog>
      <DialogTrigger asChild>
        {trigger ?? (
          <Button>
            <Plus className="h-3.5 w-3.5" />
            Top up
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className={className}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="mt-4 grid grid-cols-2 gap-3">
          {TOP_UP_PACKAGES.map((pkg) => (
            <Button
              key={pkg.label}
              variant="outline"
              loading={pending}
              onClick={() => run(() => topUpWalletAction(pkg.amountMicros), { error: "Couldn't start checkout" })}
            >
              {pkg.label}
            </Button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
