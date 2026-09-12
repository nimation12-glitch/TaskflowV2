"use client";

import { useState } from "react";
import { Coins, TrendingUp, TrendingDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Avatar } from "@/components/ui/avatar";
import { EmptyState } from "@/components/ui/empty-state";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, DialogTrigger, DialogClose } from "@/components/ui/dialog";
import { useAction } from "@/lib/hooks/use-action";
import { toast } from "@/components/ui/use-toast";
import { formatGbp, formatDateTime } from "@/lib/utils";
import type { AdminOrgDetail, PlanCode } from "@/lib/admin-client";
import { adjustCreditsAction, changePlanAction } from "./actions";

const ROLE_VARIANT: Record<string, "accent" | "default" | "outline"> = { OWNER: "accent", ADMIN: "default", MEMBER: "outline" };
const PLANS: PlanCode[] = ["FREE", "PRO", "MAX"];

function CreditsForm({ orgId, currentBalance }: { orgId: string; currentBalance: number }) {
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const { pending, run } = useAction();
  const [balance, setBalance] = useState(currentBalance);

  const amountMicros = Math.round(parseFloat(amount || "0") * 1_000_000);
  const isDeduction = amountMicros < 0;
  const valid = amountMicros !== 0 && !Number.isNaN(amountMicros) && reason.trim().length > 0;

  function handleConfirm() {
    run(() => adjustCreditsAction(orgId, amountMicros, reason.trim()), {
      error: "Couldn't adjust credits",
      onSuccess: (result) => {
        setBalance(result.new_balance_micros);
        toast({ title: `New balance: ${formatGbp(result.new_balance_micros)}`, variant: "success" });
        setAmount("");
        setReason("");
        setConfirmOpen(false);
      },
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-foreground">
          <Coins className="h-4 w-4" />
          Wallet credits
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="font-mono-data text-2xl font-semibold">{formatGbp(balance)}</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="credit-amount">Amount (£, negative to deduct)</Label>
            <Input id="credit-amount" type="number" step="0.01" placeholder="10.00" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="credit-reason">Reason (required)</Label>
            <Input id="credit-reason" placeholder="Support case #1234" value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
        </div>
        <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
          <DialogTrigger asChild>
            <Button disabled={!valid} variant={isDeduction ? "danger" : "primary"}>
              {isDeduction ? <TrendingDown className="h-4 w-4" /> : <TrendingUp className="h-4 w-4" />}
              {isDeduction ? "Deduct" : "Grant"} {amountMicros !== 0 ? formatGbp(Math.abs(amountMicros)) : "credits"}
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{isDeduction ? "Deduct" : "Grant"} {formatGbp(Math.abs(amountMicros))}?</DialogTitle>
              <DialogDescription asChild>
                <div>
                  This creates an audited ledger entry and changes the org's real wallet balance immediately.
                  <span className="mt-2 block rounded-md bg-muted/40 px-3 py-2 text-foreground">"{reason.trim()}"</span>
                </div>
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <DialogClose asChild>
                <Button variant="secondary">Cancel</Button>
              </DialogClose>
              <Button variant={isDeduction ? "danger" : "primary"} loading={pending} onClick={handleConfirm}>
                Confirm {isDeduction ? "deduction" : "grant"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}

function PlanChangeForm({ orgId, currentPlan }: { orgId: string; currentPlan: PlanCode }) {
  const [selected, setSelected] = useState<PlanCode>(currentPlan);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const { pending, run } = useAction();
  const [plan, setPlan] = useState(currentPlan);

  function handleConfirm() {
    run(() => changePlanAction(orgId, selected), {
      success: `Plan changed to ${selected}`,
      error: "Couldn't change plan",
      onSuccess: () => {
        setPlan(selected);
        setConfirmOpen(false);
      },
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-foreground">Plan</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <Badge variant={plan === "FREE" ? "default" : plan === "PRO" ? "success" : "accent"}>{plan}</Badge>
        <div className="flex items-center gap-2">
          <select
            value={selected}
            onChange={(e) => setSelected(e.target.value as PlanCode)}
            className="h-10 flex-1 rounded-md border border-border bg-muted/40 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
          >
            {PLANS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
          <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
            <DialogTrigger asChild>
              <Button disabled={selected === plan} variant="secondary">
                Change plan
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Change plan to {selected}?</DialogTitle>
                <DialogDescription>
                  This force-changes the plan without going through Stripe checkout — for support or comped
                  accounts. It bypasses billing entirely and takes effect immediately.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <DialogClose asChild>
                  <Button variant="secondary">Cancel</Button>
                </DialogClose>
                <Button loading={pending} onClick={handleConfirm}>
                  Confirm change to {selected}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </CardContent>
    </Card>
  );
}

export function OrgDetailClient({ org }: { org: AdminOrgDetail }) {
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <div className="space-y-6">
        <CreditsForm orgId={org.id} currentBalance={org.wallet_balance_micros} />
        <PlanChangeForm orgId={org.id} currentPlan={org.plan_code} />
      </div>

      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-foreground">Members ({org.members.length})</CardTitle>
          </CardHeader>
          <CardContent>
            {org.members.length === 0 ? (
              <p className="text-sm text-muted-foreground">No members.</p>
            ) : (
              <div className="divide-y divide-border">
                {org.members.map((m) => (
                  <div key={m.user_id} className="flex items-center justify-between py-3 first:pt-0 last:pb-0">
                    <div className="flex items-center gap-2.5">
                      <Avatar label={m.user_id} size="sm" />
                      <p className="font-mono-data text-xs">{m.user_id.slice(0, 13)}…</p>
                    </div>
                    <Badge variant={ROLE_VARIANT[m.role] ?? "outline"}>{m.role}</Badge>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-foreground">Recent credit transactions</CardTitle>
          </CardHeader>
          <CardContent>
            {org.recent_credit_transactions.length === 0 ? (
              <EmptyState icon={Coins} title="No transactions yet" />
            ) : (
              <div className="divide-y divide-border">
                {org.recent_credit_transactions.map((t, i) => (
                  <div key={i} className="flex items-center justify-between py-3 first:pt-0 last:pb-0">
                    <div>
                      <p className="text-sm">{t.description}</p>
                      <p className="text-xs text-muted-foreground">
                        {t.type} · {formatDateTime(t.created_at)}
                      </p>
                    </div>
                    <p className={`font-mono-data text-sm font-medium ${t.amount_micros < 0 ? "text-danger" : "text-success"}`}>
                      {t.amount_micros >= 0 ? "+" : ""}
                      {formatGbp(t.amount_micros)}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
