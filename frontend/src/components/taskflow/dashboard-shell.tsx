"use client";

/** Dashboard shell — sidebar navigation + header + view routing (SPA at /). */

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Sheet, SheetContent, SheetTrigger, SheetTitle } from "@/components/ui/sheet";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { formatGBP } from "@/lib/money";
import type { MeResponse } from "@/types/taskflow";
import {
  Zap, LayoutDashboard, KeyRound, BarChart3, CreditCard, Cpu, Boxes, BookOpen,
  LogOut, Menu, ExternalLink, ChevronDown, Users, UserCircle, Plus, Building2,
} from "lucide-react";
import { post, ApiError } from "@/lib/client-api";
import { useToast } from "@/hooks/use-toast";

export type DashboardView =
  | "overview" | "api-keys" | "usage" | "billing" | "compute" | "models" | "docs" | "team" | "account";

export const DASHBOARD_VIEWS: Array<{
  id: DashboardView; label: string; icon: React.ComponentType<{ className?: string }>;
}> = [
  { id: "overview", label: "Overview", icon: LayoutDashboard },
  { id: "api-keys", label: "API Keys", icon: KeyRound },
  { id: "usage", label: "Usage", icon: BarChart3 },
  { id: "billing", label: "Billing", icon: CreditCard },
  { id: "team", label: "Team", icon: Users },
  { id: "compute", label: "Compute", icon: Cpu },
  { id: "models", label: "Models", icon: Boxes },
  { id: "docs", label: "Docs", icon: BookOpen },
];

const PLAN_STYLES: Record<string, string> = {
  free: "border-slate-300 bg-slate-100 text-slate-700",
  pro: "border-emerald-300 bg-emerald-100 text-emerald-800",
  max: "border-amber-300 bg-amber-100 text-amber-800",
};

export function PlanBadge({ planId, className }: { planId: string; className?: string }) {
  return (
    <Badge variant="outline" className={cn("uppercase tracking-wide", PLAN_STYLES[planId] ?? PLAN_STYLES.free, className)}>
      {planId}
    </Badge>
  );
}

export function DashboardShell({ me, view, onNavigate, onLogout, onSwitchOrg, onOrgCreated, refreshMe, children }: {
  me: MeResponse;
  view: DashboardView;
  onNavigate: (v: DashboardView) => void;
  onLogout: () => void;
  onSwitchOrg: (orgId: string) => Promise<void>;
  onOrgCreated: () => Promise<void>;
  refreshMe: () => Promise<boolean>;
  children: React.ReactNode;
}) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [orgMenuOpen, setOrgMenuOpen] = useState(false);
  const [createOrgOpen, setCreateOrgOpen] = useState(false);
  const [newOrgName, setNewOrgName] = useState("");
  const [creating, setCreating] = useState(false);
  const { toast } = useToast();

  const nav = (
    <nav className="flex flex-1 flex-col gap-1 px-3">
      {DASHBOARD_VIEWS.map((item) => (
        <button
          key={item.id}
          onClick={() => { onNavigate(item.id); setMobileOpen(false); }}
          className={cn(
            "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors",
            view === item.id
              ? "bg-emerald-50 text-emerald-800"
              : "text-slate-600 hover:bg-slate-100 hover:text-slate-900",
          )}
        >
          <item.icon className={cn("h-4.5 w-4.5", view === item.id ? "text-emerald-600" : "text-slate-400")} />
          {item.label}
        </button>
      ))}
    </nav>
  );

  const sidebarInner = (
    <div className="flex h-full flex-col pb-4">
      <button
        onClick={() => { onNavigate("overview"); setMobileOpen(false); }}
        className="flex items-center gap-2 px-5 py-5 text-left"
      >
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-600">
          <Zap className="h-4.5 w-4.5 text-white" strokeWidth={2.5} />
        </div>
        <div>
          <div className="text-base font-semibold tracking-tight text-slate-900">TaskFlow</div>
          <div className="text-[11px] text-slate-400">AI API platform</div>
        </div>
      </button>
      <div className="mx-3 mb-4 rounded-xl border border-slate-200 bg-slate-50 p-3">
        {/* Organization switcher (§42) — lists ONLY the user's memberships. */}
        <div className="relative">
          <button
            onClick={() => setOrgMenuOpen((v) => !v)}
            className="flex w-full items-center justify-between gap-2 rounded-lg px-1.5 py-1 text-left hover:bg-slate-100"
            aria-haspopup="menu"
            aria-expanded={orgMenuOpen}
          >
            <span className="flex min-w-0 items-center gap-2">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded bg-slate-200">
                <Building2 className="h-3.5 w-3.5 text-slate-500" />
              </span>
              <span className="min-w-0">
                <span className="block truncate text-xs font-semibold text-slate-800">{me.organization?.name ?? "—"}</span>
                <span className="block text-[10px] uppercase tracking-wide text-slate-400">{me.role}</span>
              </span>
            </span>
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-slate-400" />
          </button>
          {orgMenuOpen && (
            <div className="absolute left-0 top-9 z-20 w-60 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-lg" role="menu">
              {me.organizations.map((org) => (
                <button
                  key={org.id}
                  className={cn(
                    "flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-slate-50",
                    org.id === me.organization?.id && "bg-emerald-50 text-emerald-800",
                  )}
                  onClick={async () => {
                    setOrgMenuOpen(false);
                    if (org.id !== me.organization?.id) await onSwitchOrg(org.id);
                  }}
                >
                  <span className="min-w-0 truncate">{org.name}</span>
                  <span className="text-[10px] uppercase text-slate-400">{org.role}</span>
                </button>
              ))}
              <button
                className="flex w-full items-center gap-2 border-t border-slate-100 px-3 py-2.5 text-sm text-slate-700 hover:bg-slate-50"
                onClick={() => { setOrgMenuOpen(false); setCreateOrgOpen(true); }}
              >
                <Plus className="h-4 w-4 text-slate-400" /> New organization
              </button>
            </div>
          )}
        </div>
        <div className="mt-3 flex items-center justify-between">
          <span className="text-xs font-medium text-slate-500">Credit balance</span>
          <PlanBadge planId={me.subscription?.planId ?? "free"} />
        </div>
        <div className="mt-1.5 text-xl font-bold tracking-tight text-slate-900">
          {formatGBP(me.credits.balanceMicros)}
        </div>
        <div className="text-[11px] text-slate-400">
          {me.subscription ? `${me.subscription.planName} · ${me.subscription.rateLimitPerMinute} rpm` : "No plan"}
        </div>
      </div>
      {nav}
      <div className="mt-2 px-3">
        <a
          href="/api/health"
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-2 rounded-lg px-3 py-2 text-xs text-slate-400 hover:text-slate-600"
        >
          <ExternalLink className="h-3.5 w-3.5" /> Platform status
        </a>
        <button
          onClick={onLogout}
          className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-900"
        >
          <LogOut className="h-4.5 w-4.5 text-slate-400" /> Sign out
        </button>
      </div>
    </div>
  );

  return (
    <div className="flex min-h-screen bg-slate-50">
      {/* Desktop sidebar */}
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-slate-200 bg-white lg:flex">
        {sidebarInner}
      </aside>

      {/* Mobile sidebar */}
      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent side="left" className="w-64 bg-white p-0">
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          {sidebarInner}
        </SheetContent>
      </Sheet>

      {/* Main */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center justify-between gap-3 border-b border-slate-200 bg-white/90 px-4 backdrop-blur sm:px-6">
          <div className="flex items-center gap-3">
            <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
              <SheetTrigger asChild>
                <Button variant="ghost" size="icon" className="lg:hidden" aria-label="Open navigation">
                  <Menu className="h-5 w-5" />
                </Button>
              </SheetTrigger>
            </Sheet>
            <h1 className="text-sm font-semibold text-slate-900 sm:text-base">
              {DASHBOARD_VIEWS.find((v) => v.id === view)?.label}
            </h1>
          </div>
          <div className="flex items-center gap-3">
            {me.billingMode === "test" && (
              <Badge variant="outline" className="hidden border-amber-300 bg-amber-50 text-amber-700 sm:inline-flex">
                Stripe Test Mode
              </Badge>
            )}
            {me.billingMode === "unconfigured" && (
              <Badge variant="outline" className="hidden border-rose-300 bg-rose-50 text-rose-700 sm:inline-flex">
                Billing not configured
              </Badge>
            )}
            <div className="relative">
              <button
                onClick={() => setUserMenuOpen((v) => !v)}
                className="flex items-center gap-2 rounded-full border border-slate-200 bg-white py-1 pl-1 pr-2 hover:bg-slate-50"
                aria-haspopup="menu"
                aria-expanded={userMenuOpen}
              >
                <span className="flex h-7 w-7 items-center justify-center rounded-full bg-emerald-600 text-xs font-bold text-white">
                  {(me.user?.name ?? me.user?.email ?? "?").slice(0, 1).toUpperCase()}
                </span>
                <span className="hidden max-w-36 truncate text-sm text-slate-700 sm:block">
                  {me.user?.email}
                </span>
                <ChevronDown className="h-3.5 w-3.5 text-slate-400" />
              </button>
              {userMenuOpen && (
                <div
                  className="absolute right-0 top-11 w-56 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-lg"
                  role="menu"
                >
                  <div className="border-b border-slate-100 px-4 py-3">
                    <div className="truncate text-sm font-medium text-slate-900">{me.user?.name ?? "—"}</div>
                    <div className="truncate text-xs text-slate-500">{me.user?.email}</div>
                  </div>
                  <button
                    className="flex w-full items-center gap-2 px-4 py-2.5 text-sm text-slate-700 hover:bg-slate-50"
                    onClick={() => { setUserMenuOpen(false); onNavigate("account"); }}
                  >
                    <UserCircle className="h-4 w-4 text-slate-400" /> Account
                  </button>
                  <button
                    className="flex w-full items-center gap-2 px-4 py-2.5 text-sm text-slate-700 hover:bg-slate-50"
                    onClick={() => { setUserMenuOpen(false); onNavigate("billing"); }}
                  >
                    <CreditCard className="h-4 w-4 text-slate-400" /> Billing &amp; plan
                  </button>
                  <button
                    className="flex w-full items-center gap-2 px-4 py-2.5 text-sm text-slate-700 hover:bg-slate-50"
                    onClick={onLogout}
                  >
                    <LogOut className="h-4 w-4 text-slate-400" /> Sign out
                  </button>
                </div>
              )}
            </div>
          </div>
        </header>
        <main className="flex-1 px-4 py-6 sm:px-6 lg:px-8">
          <div className="mx-auto max-w-6xl">{children}</div>
        </main>
        <footer className="mt-auto border-t border-slate-200 bg-white px-6 py-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
          <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-2 text-xs text-slate-400 sm:flex-row">
            <span>© {new Date().getFullYear()} TaskFlow — unified AI API &amp; infrastructure</span>
            <span className="flex items-center gap-4">
              <span>API base: <code className="rounded bg-slate-100 px-1.5 py-0.5 text-slate-600">/api/v1</code></span>
              <span>Status: <span className="font-medium text-emerald-600">operational</span></span>
            </span>
          </div>
        </footer>
      </div>

      {/* New organization dialog (§22) */}
      <Dialog open={createOrgOpen} onOpenChange={setCreateOrgOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create organization</DialogTitle>
          </DialogHeader>
          <Input
            placeholder="Acme AI Ltd"
            value={newOrgName}
            onChange={(e) => setNewOrgName(e.target.value)}
            maxLength={60}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOrgOpen(false)}>Cancel</Button>
            <Button
              className="bg-emerald-600 text-white hover:bg-emerald-500"
              disabled={creating || newOrgName.trim().length < 1}
              onClick={async () => {
                setCreating(true);
                try {
                  await post("/api/orgs", { name: newOrgName.trim() });
                  await onOrgCreated();
                  toast({ title: "Organization created", description: "You are the OWNER." });
                  setCreateOrgOpen(false);
                  setNewOrgName("");
                  onNavigate("overview");
                } catch (err) {
                  toast({ title: err instanceof ApiError ? err.message : "Creation failed", variant: "destructive" });
                } finally {
                  setCreating(false);
                }
              }}
            >
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export async function logout(): Promise<void> {
  await post("/api/auth/logout", {}).catch(() => undefined);
}
