"use client";

import { Wallet } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { formatGbp } from "@/lib/utils";
import { TopUpDialog } from "@/components/dashboard/top-up-dialog";

export function WalletWidget({
  balanceMicros,
  estimatedHoursRemaining,
  compact,
}: {
  balanceMicros: number;
  estimatedHoursRemaining: number | null;
  compact?: boolean;
}) {
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
      <TopUpDialog />
    </div>
  );

  if (compact) return inner;

  return (
    <Card>
      <CardContent className="pt-5">{inner}</CardContent>
    </Card>
  );
}
