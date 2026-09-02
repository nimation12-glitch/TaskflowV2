"use client";

/**
 * TaskFlow — application root.
 *
 * SPA architecture note: the sandbox preview only surfaces the `/` route,
 * so the entire product (landing, auth, dashboard sections, auth flows) is
 * composed here with hash-based navigation:
 *   #/, #/auth[/signin], #/dashboard/{view},
 *   #/auth/finishing (OAuth return), #/verify-email?token=…,
 *   #/reset-password?token=…, #/invite?token=…
 * Backend endpoints live under /api/** (not user-visible pages).
 */

import { useCallback, useEffect, useState } from "react";
import { Landing } from "@/components/taskflow/landing";
import { AuthView } from "@/components/taskflow/auth-view";
import { AuthFinishingScreen, InviteScreen, PendingVerificationScreen, ResetPasswordScreen, VerifyEmailScreen } from "@/components/taskflow/auth-screens";
import { DashboardShell, logout, type DashboardView } from "@/components/taskflow/dashboard-shell";
import { OverviewView } from "@/components/taskflow/overview-view";
import { ApiKeysView } from "@/components/taskflow/api-keys-view";
import { UsageView } from "@/components/taskflow/usage-view";
import { BillingView } from "@/components/taskflow/billing-view";
import { ComputeView } from "@/components/taskflow/compute-view";
import { ModelsView } from "@/components/taskflow/models-view";
import { DocsView } from "@/components/taskflow/docs-view";
import { TeamView } from "@/components/taskflow/team-view";
import { AccountView } from "@/components/taskflow/account-view";
import { api, post } from "@/lib/client-api";
import type { MeResponse } from "@/types/taskflow";
import { Loader2 } from "lucide-react";

type Screen =
  | { name: "loading" }
  | { name: "landing" }
  | { name: "auth"; mode: "signin" | "signup" }
  | { name: "auth-finishing" }
  | { name: "pending" }
  | { name: "verify-email"; token: string | null }
  | { name: "reset-password"; token: string | null }
  | { name: "invite"; token: string | null }
  | { name: "dashboard" };

type HashRoute = { screen: Screen; view: DashboardView };

const DASHBOARD_VIEW_IDS: DashboardView[] = [
  "overview", "api-keys", "usage", "billing", "compute", "models", "docs", "team", "account",
];

function parseHash(): HashRoute {
  const raw = window.location.hash.replace(/^#/, "");
  const [path, query] = raw.split("?");
  const params = new URLSearchParams(query ?? "");
  const viewFor = (seg: string): DashboardView =>
    seg && DASHBOARD_VIEW_IDS.includes(seg as DashboardView) ? (seg as DashboardView) : "overview";

  if (path.startsWith("/dashboard")) {
    return { screen: { name: "dashboard" }, view: viewFor(path.split("/")[2] ?? "") };
  }
  if (path.startsWith("/auth/finishing")) {
    return { screen: { name: "auth-finishing" }, view: "overview" };
  }
  if (path.startsWith("/auth/pending")) {
    return { screen: { name: "pending" }, view: "overview" };
  }
  if (path.startsWith("/verify-email")) {
    return { screen: { name: "verify-email", token: params.get("token") }, view: "overview" };
  }
  if (path.startsWith("/reset-password")) {
    return { screen: { name: "reset-password", token: params.get("token") }, view: "overview" };
  }
  if (path.startsWith("/invite")) {
    return { screen: { name: "invite", token: params.get("token") }, view: "overview" };
  }
  if (path.startsWith("/auth")) {
    const mode = path.endsWith("/signin") ? "signin" : "signup";
    return { screen: { name: "auth", mode }, view: "overview" };
  }
  return { screen: { name: "landing" }, view: "overview" };
}

export default function Page() {
  const [screen, setScreen] = useState<Screen>({ name: "loading" });
  const [view, setView] = useState<DashboardView>("overview");
  const [me, setMe] = useState<MeResponse | null>(null);

  const refreshMe = useCallback(async () => {
    try {
      const data = await api<MeResponse>("/api/auth/me");
      if (data.user) {
        setMe(data);
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }, []);

  // Bootstrap: resolve session + hash route.
  useEffect(() => {
    (async () => {
      const { screen: s, view: v } = parseHash();
      setView(v);
      // OAuth/verify/reset/invite/pending screens render regardless of session state.
      if (s.name === "auth-finishing" || s.name === "verify-email" || s.name === "reset-password" || s.name === "invite" || s.name === "pending") {
        await refreshMe().catch(() => undefined);
        setScreen(s);
        return;
      }
      const authed = await refreshMe();
      if (authed) {
        // Pending accounts (verification policy unsatisfied, §17) route into
        // the verification screens — never straight to the dashboard.
        try {
          const fresh = await api<MeResponse>("/api/auth/me");
          if (fresh.pending) {
            setScreen({ name: "pending" });
            return;
          }
        } catch {
          // fall through to normal routing
        }
      }
      if (authed && (s.name === "landing" || s.name === "dashboard")) {
        setScreen({ name: "dashboard" });
        if (s.name === "landing") window.location.hash = "#/dashboard";
      } else if (s.name === "auth" && authed) {
        setScreen({ name: "dashboard" });
        window.location.hash = "#/dashboard";
      } else {
        setScreen(s.name === "loading" ? { name: "landing" } : s);
      }
    })();
  }, []);

  // Hash routing.
  useEffect(() => {
    const onHash = () => {
      const { screen: s, view: v } = parseHash();
      setView(v);
      if (s.name === "auth-finishing" || s.name === "verify-email" || s.name === "reset-password" || s.name === "invite" || s.name === "pending") {
        setScreen(s);
      } else if (s.name === "dashboard" && me?.pending) {
        // Pending accounts can never see the dashboard (§17).
        setScreen({ name: "pending" });
      } else if (s.name === "dashboard" && !me) {
        refreshMe().then((ok) => setScreen(ok ? { name: "dashboard" } : { name: "auth", mode: "signin" }));
      } else if (s.name === "dashboard") {
        setScreen({ name: "dashboard" });
      } else {
        setScreen(s);
      }
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [me, refreshMe]);

  const navigate = useCallback((next: DashboardView) => {
    setView(next);
    window.location.hash = `#/dashboard/${next}`;
    window.scrollTo({ top: 0 });
  }, []);

  const goAuth = useCallback((mode: "signin" | "signup") => {
    window.location.hash = `#/auth${mode === "signin" ? "/signin" : ""}`;
    setScreen({ name: "auth", mode });
  }, []);

  const onAuthed = useCallback(async () => {
    const ok = await refreshMe();
    if (!ok) return;
    // Pending accounts (verification policy unsatisfied, §17) go through
    // the verification screens — never straight to the dashboard.
    try {
      const fresh = await api<MeResponse>("/api/auth/me");
      if (fresh.pending) {
        window.location.hash = "#/auth/pending";
        setScreen({ name: "pending" });
        return;
      }
    } catch {
      // fall through to the dashboard
    }
    window.location.hash = "#/dashboard";
    setScreen({ name: "dashboard" });
  }, [refreshMe]);

  const onLogout = useCallback(async () => {
    await logout();
    setMe(null);
    window.location.hash = "#/";
    setScreen({ name: "landing" });
  }, []);

  const switchOrg = useCallback(async (orgId: string) => {
    await post("/api/orgs/active", { organizationId: orgId });
    await refreshMe();
    setView("overview");
    window.location.hash = "#/dashboard";
    window.scrollTo({ top: 0 });
  }, [refreshMe]);

  const orgCreated = useCallback(async () => {
    await refreshMe();
  }, [refreshMe]);

  if (screen.name === "loading") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-950">
        <Loader2 className="h-7 w-7 animate-spin text-emerald-400" />
      </div>
    );
  }

  if (screen.name === "landing") {
    return <Landing onAuth={goAuth} />;
  }

  if (screen.name === "auth-finishing") {
    return (
      <AuthFinishingScreen
        onAuthed={onAuthed}
        onDone={() => goAuth("signin")}
      />
    );
  }

  if (screen.name === "verify-email") {
    return <VerifyEmailScreen token={screen.token} onAuthed={onAuthed} onPending={() => { window.location.hash = "#/auth/pending"; setScreen({ name: "pending" }); }} />;
  }

  if (screen.name === "pending") {
    return (
      <PendingVerificationScreen
        me={me}
        refreshMe={refreshMe}
        onAuthed={async () => {
          window.location.hash = "#/dashboard";
          setScreen({ name: "dashboard" });
        }}
        onSignOut={onLogout}
      />
    );
  }

  if (screen.name === "reset-password") {
    return (
      <ResetPasswordScreen
        token={screen.token}
        onDone={() => {
          window.location.hash = "#/auth/signin";
          setScreen({ name: "auth", mode: "signin" });
        }}
      />
    );
  }

  if (screen.name === "invite") {
    return (
      <InviteScreen
        token={screen.token}
        me={me}
        onAuthed={async () => {
          await refreshMe();
          window.location.hash = "#/dashboard";
          setScreen({ name: "dashboard" });
        }}
        onGoAuth={() => goAuth("signin")}
      />
    );
  }

  if (screen.name === "auth") {
    return <AuthView initialMode={screen.mode} onBack={() => { window.location.hash = "#/"; setScreen({ name: "landing" }); }} onAuthed={onAuthed} />;
  }

  if (!me) {
    // Session vanished mid-flight — return to auth.
    return <AuthView initialMode="signin" onBack={() => { window.location.hash = "#/"; setScreen({ name: "landing" }); }} onAuthed={onAuthed} />;
  }

  return (
    <DashboardShell
      me={me}
      view={view}
      onNavigate={navigate}
      onLogout={onLogout}
      onSwitchOrg={switchOrg}
      onOrgCreated={orgCreated}
      refreshMe={refreshMe}
    >
      {view === "overview" && <OverviewView me={me} onNavigate={navigate} refreshMe={refreshMe} />}
      {view === "api-keys" && <ApiKeysView />}
      {view === "usage" && <UsageView />}
      {view === "billing" && <BillingView me={me} refreshMe={refreshMe} />}
      {view === "team" && <TeamView me={me} refreshMe={refreshMe} />}
      {view === "account" && <AccountView me={me} refreshMe={refreshMe} onLogout={onLogout} />}
      {view === "compute" && <ComputeView me={me} />}
      {view === "models" && <ModelsView onNavigate={navigate} />}
      {view === "docs" && <DocsView me={me} onNavigate={navigate} />}
    </DashboardShell>
  );
}
