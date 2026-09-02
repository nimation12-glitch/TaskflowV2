"use client";

/** TaskFlow marketing landing page — honest, no unsupported promises (§22). */

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import {
  Zap, KeyRound, Gauge, Coins, Layers, ShieldCheck, Server, Boxes,
  ArrowRight, Terminal, LineChart, Lock, Globe, Check,
} from "lucide-react";
import { formatGBP } from "@/lib/money";

const PLANS = [
  {
    id: "free", name: "Free", price: 0, credits: 2, rpm: 20, priority: "Lowest shared priority",
    features: ["£2 monthly AI usage credits", "Basic model access", "20 requests/minute", "API key creation", "Basic dashboard"],
  },
  {
    id: "pro", name: "Pro", price: 30, credits: 15, rpm: 100, priority: "Higher shared priority",
    features: ["£15 monthly AI usage credits", "Broader model access", "100 requests/minute", "Usage analytics", "Purchase extra credits", "Rent dedicated GPUs"],
    highlight: true,
  },
  {
    id: "max", name: "Max", price: 90, credits: 50, rpm: 300, priority: "Highest shared priority",
    features: ["£50 monthly AI usage credits", "Premium model access", "300 requests/minute", "Advanced analytics", "Purchase extra credits", "Rent dedicated GPUs"],
  },
];

const FEATURES = [
  { icon: Zap, title: "One unified AI API", body: "Call every model on TaskFlow through a single OpenAI-compatible endpoint. Swap models with one string — no SDK rewrites." },
  { icon: KeyRound, title: "API keys you control", body: "Create, name and revoke keys from the dashboard. Keys are hashed with a pepper and shown only once at creation." },
  { icon: Gauge, title: "Usage controls built in", body: "Per-plan rate limits, concurrency caps and credit balances protect you from runaway spend on day one." },
  { icon: Coins, title: "Simple AI credits", body: "1 credit ≈ £1 of usage. Monthly allowance included with your plan, top up when you need more." },
  { icon: LineChart, title: "Token-level tracking", body: "Every request records input/output tokens, latency, provider and charge — visible to you, auditable to us." },
  { icon: Layers, title: "Model entitlements", body: "Model access grows with your plan, from cost-efficient basics to premium reasoning models." },
  { icon: Server, title: "Dedicated GPU rental (soon)", body: "Rent GPUs by the hour, deploy your own models, and get a managed TaskFlow endpoint with auth and metering." },
  { icon: ShieldCheck, title: "Security first", body: "Hashed keys, signed Stripe webhooks, server-side entitlement checks and server-side pricing. Never trust the client." },
];

export function Landing({ onAuth }: { onAuth: (mode: "signin" | "signup") => void }) {
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      {/* Nav */}
      <header className="sticky top-0 z-40 border-b border-white/10 bg-slate-950/80 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-500">
              <Zap className="h-4.5 w-4.5 text-slate-950" strokeWidth={2.5} />
            </div>
            <span className="text-lg font-semibold tracking-tight">TaskFlow</span>
          </div>
          <nav className="hidden items-center gap-6 text-sm text-slate-300 md:flex">
            <a href="#features" className="hover:text-white">Features</a>
            <a href="#how" className="hover:text-white">How it works</a>
            <a href="#pricing" className="hover:text-white">Pricing</a>
            <a href="#faq" className="hover:text-white">FAQ</a>
          </nav>
          <div className="flex items-center gap-2">
            <Button variant="ghost" className="text-slate-200 hover:text-white hover:bg-white/10" onClick={() => onAuth("signin")}>
              Sign in
            </Button>
            <Button className="bg-emerald-500 text-slate-950 hover:bg-emerald-400" onClick={() => onAuth("signup")}>
              Get started
            </Button>
          </div>
        </div>
      </header>

      {/* Hero */}
      <section className="relative overflow-hidden">
        <div className="pointer-events-none absolute -top-40 left-1/2 h-130 w-200 -translate-x-1/2 rounded-full bg-emerald-500/15 blur-3xl" />
        <div className="pointer-events-none absolute top-40 -left-40 h-100 w-100 rounded-full bg-teal-500/10 blur-3xl" />
        <div className="mx-auto max-w-6xl px-4 pt-20 pb-16 sm:px-6 sm:pt-28">
          <div className="flex flex-col items-center text-center">
            <Badge variant="outline" className="mb-6 border-emerald-500/40 bg-emerald-500/10 text-emerald-300">
              <Terminal className="mr-1.5 h-3.5 w-3.5" /> Unified AI API &amp; infrastructure platform
            </Badge>
            <h1 className="max-w-3xl text-4xl font-bold tracking-tight sm:text-6xl">
              One API. Every model.{" "}
              <span className="bg-gradient-to-r from-emerald-300 to-teal-300 bg-clip-text text-transparent">
                Usage you can actually control.
              </span>
            </h1>
            <p className="mt-6 max-w-2xl text-lg text-slate-400">
              TaskFlow gives your product a single OpenAI-compatible gateway for AI models — with API keys,
              credit-based billing, token-level usage tracking and rate limits that scale with your plan.
            </p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <Button size="lg" className="bg-emerald-500 text-slate-950 hover:bg-emerald-400" onClick={() => onAuth("signup")}>
                Create free account <ArrowRight className="ml-2 h-4 w-4" />
              </Button>
              <Button size="lg" variant="outline" className="border-white/20 bg-transparent text-white hover:bg-white/10" onClick={() => onAuth("signin")}>
                Sign in to dashboard
              </Button>
            </div>

            {/* Code sample */}
            <div className="mt-12 w-full max-w-2xl overflow-hidden rounded-xl border border-white/10 bg-slate-900 text-left shadow-2xl">
              <div className="flex items-center gap-2 border-b border-white/10 px-4 py-2.5">
                <span className="h-2.5 w-2.5 rounded-full bg-rose-400/70" />
                <span className="h-2.5 w-2.5 rounded-full bg-amber-400/70" />
                <span className="h-2.5 w-2.5 rounded-full bg-emerald-400/70" />
                <span className="ml-2 text-xs text-slate-500">your first request</span>
              </div>
              <pre className="overflow-x-auto p-4 text-[13px] leading-relaxed text-slate-300">
{`curl https://api.taskflow.web-agent.org/api/v1/chat/completions \\
  -H "Authorization: Bearer tf_live_YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "taskflow-mini",
    "messages": [{"role": "user", "content": "Hello TaskFlow!"}]
  }'`}
              </pre>
            </div>
          </div>
        </div>
      </section>

      {/* Features */}
      <section id="features" className="border-t border-white/5 bg-slate-950 py-20">
        <div className="mx-auto max-w-6xl px-4 sm:px-6">
          <div className="mx-auto max-w-2xl text-center">
            <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">Everything an AI product needs</h2>
            <p className="mt-4 text-slate-400">
              Simple for you to use. Sophisticated underneath — metering, entitlements, provider routing and
              billing are handled by TaskFlow.
            </p>
          </div>
          <div className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
            {FEATURES.map((f) => (
              <Card key={f.title} className="border-white/10 bg-white/5 text-slate-100">
                <CardHeader className="pb-2">
                  <div className="mb-2 flex h-9 w-9 items-center justify-center rounded-lg bg-emerald-500/15">
                    <f.icon className="h-4.5 w-4.5 text-emerald-300" />
                  </div>
                  <CardTitle className="text-base">{f.title}</CardTitle>
                </CardHeader>
                <CardContent className="text-sm text-slate-400">{f.body}</CardContent>
              </Card>
            ))}
          </div>
        </div>
      </section>

      {/* How it works */}
      <section id="how" className="border-t border-white/5 py-20">
        <div className="mx-auto max-w-6xl px-4 sm:px-6">
          <h2 className="text-center text-3xl font-bold tracking-tight sm:text-4xl">How TaskFlow works</h2>
          <div className="mt-12 grid gap-6 md:grid-cols-4">
            {[
              { icon: Layers, step: "1", title: "Choose a plan", body: "Start free, upgrade when you're ready. Each plan includes a monthly AI credit allowance." },
              { icon: KeyRound, step: "2", title: "Create an API key", body: "Generate keys from the dashboard. Shown once, stored hashed, revocable anytime." },
              { icon: Zap, step: "3", title: "Call the API", body: "Use the OpenAI-compatible endpoint with any model your plan entitles you to." },
              { icon: Gauge, step: "4", title: "Track & top up", body: "Watch usage per token in the dashboard. Buy extra credits or upgrade as you grow." },
            ].map((s) => (
              <div key={s.step} className="relative rounded-xl border border-white/10 bg-white/5 p-6">
                <div className="absolute -top-3 -left-3 flex h-8 w-8 items-center justify-center rounded-full bg-emerald-500 text-sm font-bold text-slate-950">
                  {s.step}
                </div>
                <s.icon className="mb-3 h-6 w-6 text-emerald-300" />
                <h3 className="font-semibold">{s.title}</h3>
                <p className="mt-2 text-sm text-slate-400">{s.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Pricing */}
      <section id="pricing" className="border-t border-white/5 bg-slate-900/40 py-20">
        <div className="mx-auto max-w-6xl px-4 sm:px-6">
          <div className="mx-auto max-w-2xl text-center">
            <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">Simple, usage-based pricing</h2>
            <p className="mt-4 text-slate-400">
              Plans include a monthly AI credit allowance (1 credit ≈ £1 of usage). Allowances are not unlimited
              usage — beyond the allowance, purchase credits as you need them.
            </p>
          </div>
          <div className="mt-12 grid gap-6 lg:grid-cols-3">
            {PLANS.map((p) => (
              <Card
                key={p.id}
                className={`relative flex flex-col border bg-slate-950 ${p.highlight ? "border-emerald-500/50 shadow-[0_0_40px_-12px] shadow-emerald-500/30" : "border-white/10"}`}
              >
                {p.highlight && (
                  <Badge className="absolute -top-2.5 left-1/2 -translate-x-1/2 bg-emerald-500 text-slate-950">
                    Most popular
                  </Badge>
                )}
                <CardHeader>
                  <CardTitle className="text-slate-100">{p.name}</CardTitle>
                  <div className="mt-2 flex items-baseline gap-1">
                    <span className="text-4xl font-bold text-white">£{p.price}</span>
                    <span className="text-sm text-slate-400">/month</span>
                  </div>
                  <CardDescription className="text-slate-400">
                    Includes {formatGBP(p.credits, { force4dp: false })} monthly AI usage credits
                  </CardDescription>
                </CardHeader>
                <CardContent className="flex flex-1 flex-col">
                  <div className="mb-4 flex items-center gap-2 text-sm text-slate-300">
                    <Gauge className="h-4 w-4 text-emerald-400" /> {p.rpm} requests/minute · {p.priority}
                  </div>
                  <ul className="flex-1 space-y-2.5 text-sm">
                    {p.features.map((f) => (
                      <li key={f} className="flex items-start gap-2 text-slate-300">
                        <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" /> {f}
                      </li>
                    ))}
                  </ul>
                  <Button
                    className={`mt-6 w-full ${p.highlight ? "bg-emerald-500 text-slate-950 hover:bg-emerald-400" : "bg-white/10 text-white hover:bg-white/20"}`}
                    onClick={() => onAuth("signup")}
                  >
                    {p.price === 0 ? "Start free" : `Choose ${p.name}`}
                  </Button>
                </CardContent>
              </Card>
            ))}
          </div>
          <p className="mt-6 text-center text-xs text-slate-500">
            Prices are in GBP per calendar month. Included credits expire at the end of each monthly period.
            Model availability and upstream pricing may change — the dashboard always shows current entitlements.
          </p>
        </div>
      </section>

      {/* FAQ */}
      <section id="faq" className="border-t border-white/5 py-20">
        <div className="mx-auto max-w-3xl px-4 sm:px-6">
          <h2 className="text-center text-3xl font-bold tracking-tight">Questions, answered</h2>
          <div className="mt-10 space-y-8">
            {[
              {
                q: "Is the monthly credit allowance unlimited usage?",
                a: "No. Each plan includes a fixed monthly allowance (£2 / £15 / £50 of usage value). When it runs out you purchase additional credits — this keeps TaskFlow sustainable and prevents surprise bills.",
              },
              {
                q: "How is usage calculated?",
                a: "Per request: input tokens × input rate + output tokens × output rate, plus a platform margin. GPU time, when you rent dedicated GPUs, is billed per second of runtime and tracked separately from tokens.",
              },
              {
                q: "Do unused credits roll over?",
                a: "Monthly allowances refresh at the start of each subscription period and unused allowance does not roll over. Purchased credits remain available on your account balance.",
              },
              {
                q: "Which models can I use?",
                a: "Access depends on your plan. The Models page in the dashboard always shows the current catalog, entitlements and pricing. The backend enforces access — the frontend is never the source of truth.",
              },
              {
                q: "What about GPU hosting?",
                a: "Dedicated GPU rental and managed customer model deployments are the next phase of TaskFlow. The compute page already shows the planned GPU catalog and pricing direction.",
              },
            ].map((item) => (
              <div key={item.q} className="rounded-xl border border-white/10 bg-white/5 p-6">
                <h3 className="font-semibold text-slate-100">{item.q}</h3>
                <p className="mt-2 text-sm leading-relaxed text-slate-400">{item.a}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="border-t border-white/5 py-20">
        <div className="mx-auto max-w-3xl px-4 text-center sm:px-6">
          <div className="pointer-events-none mx-auto h-40 w-80 rounded-full bg-emerald-500/15 blur-3xl" />
          <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">Ready to ship with TaskFlow?</h2>
          <p className="mt-4 text-slate-400">
            Create an account, get £2 of monthly AI credits on the Free plan, and make your first API call in minutes.
          </p>
          <Button size="lg" className="mt-8 bg-emerald-500 text-slate-950 hover:bg-emerald-400" onClick={() => onAuth("signup")}>
            Get started free <ArrowRight className="ml-2 h-4 w-4" />
          </Button>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-white/10 py-10">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-6 px-4 sm:flex-row sm:px-6">
          <div className="flex items-center gap-2 text-sm text-slate-400">
            <div className="flex h-6 w-6 items-center justify-center rounded-md bg-emerald-500">
              <Zap className="h-3.5 w-3.5 text-slate-950" strokeWidth={2.5} />
            </div>
            © {new Date().getFullYear()} TaskFlow · taskflow.web-agent.org
          </div>
          <div className="flex items-center gap-5 text-sm text-slate-400">
            <span className="flex items-center gap-1.5"><Globe className="h-3.5 w-3.5" /> United Kingdom</span>
            <span className="flex items-center gap-1.5"><Lock className="h-3.5 w-3.5" /> Keys stored hashed</span>
            <span className="flex items-center gap-1.5"><Boxes className="h-3.5 w-3.5" /> Stripe payments</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
