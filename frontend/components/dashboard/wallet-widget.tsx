"use client";

import { Wallet, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogTrigger } from "@/components/ui/dialog";
import { useAction } from "@/lib/hooks/use-action";
import { formatGbp } from "@/lib/utils";
import { topUpWalletAction } from "@/app/(app)/compute/actions";

const PACKAGES = [
  { label: "£10", amountMicros: 10_000_000 },
  { label: "£25", amountMicros: 25_000_000 },
  { label: "£50", amountMicros: 50_000_000 },
  { label: "£100", amountMicros: 100_000_000 },
];

export function WalletWidget({
  balanceMicros,
  estimatedHoursRemaining,
  compact,
}: {
  balanceMicros: number;
  estimatedHoursRemaining: number | null;
  compact?: boolean;
}) {
  const { pending, run } = useAction();

  const inner = (
    <div className="flex items-center justify-between gap-4">
      <div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Wallet className="h-3.5 w-3.5" />
          GPU wallet balance
        </div>
        <p className="mt-1 font-mono-data text-2xl font-semibold">{formatGbp(balanceMicros)}</p>
        {estimatedHoursRemaining !== null && (
          <p className="mt-0.5 text-xs text-muted-foreground">
            ≈ {estimatedHoursRemaining < 1 ? "under an hour" : `${estimatedHoursRemaining.toFixed(1)} hours`} at your
            current rate
          </p>
        )}
      </div>
      <Dialog>
        <DialogTrigger asChild>
          <Button size={compact ? "sm" : "default"}>
            <Plus className="h-3.5 w-3.5" />
            Top up
          </Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Top up your GPU wallet</DialogTitle>
            <DialogDescription>Choose an amount — you'll be redirected to secure Stripe checkout.</DialogDescription>
          </DialogHeader>
          <div className="mt-4 grid grid-cols-2 gap-3">
            {PACKAGES.map((pkg) => (
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
    </div>
  );

  if (compact) return inner;

  return (
    <Card>
      <CardContent className="pt-5">{inner}</CardContent>
    </Card>
  );
}
