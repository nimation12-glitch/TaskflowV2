import Link from "next/link";
import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { PLAN_LIMITS, type PlanCode } from "@/lib/compute-types";
import { GPU_CATALOG_REFERENCE } from "@/lib/gpu-catalog-reference";

const PLANS: { code: PlanCode; name: string; price: string; tagline: string; highlighted?: boolean }[] = [
  { code: "FREE", name: "Free", price: "£0", tagline: "Try it out." },
  { code: "PRO", name: "Pro", price: "£30", tagline: "For regular projects.", highlighted: true },
  { code: "MAX", name: "Max", price: "£90", tagline: "For heavy workloads." },
];

function planFeatures(code: PlanCode): string[] {
  const l = PLAN_LIMITS[code];
  const rateNote = l.ratesMultiplier < 1 ? `${Math.round((1 - l.ratesMultiplier) * 100)}% off all GPU rates` : "Standard GPU rates";
  const bookingNote = l.bookingAllowed ? "Pay-as-you-go or upfront day/week booking" : "Pay-as-you-go only";
  return [
    `${l.concurrentRentals} concurrent rental${l.concurrentRentals > 1 ? "s" : ""}`,
    `${l.maxStorageGb}GB storage max`,
    code === "FREE" ? "4-hour max session length" : `${l.maxBookingDays}-day max rental length`,
    rateNote,
    bookingNote,
    `${l.queuePriority} queue priority`,
  ];
}

const CAPABILITIES = [
  { title: "Real GPUs, by the hour", body: "T4s and A10Gs, provisioned in minutes. SSH in and run whatever you need — training, inference, rendering, whatever the job is." },
  { title: "Pay for what you use", body: "A reloadable wallet meters your rental to the hour, or lock in a fixed price upfront with a day or week booking. No surprise invoices either way." },
  { title: "No infrastructure babysitting", body: "Auto-stop on low balance instead of losing your instance. Auto-terminate at the end of a booked period. You keep control, we keep it predictable." },
];

export default function LandingPage() {
  return (
    <div className="min-h-screen">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-6 py-6">
        <span className="text-lg font-semibold tracking-tight">TaskFlow</span>
        <nav className="flex items-center gap-3">
          <Link href="/login" className="text-sm text-muted-foreground hover:text-foreground">
            Sign in
          </Link>
          <Link href="/signup">
            <Button>Start building</Button>
          </Link>
        </nav>
      </header>

      <section className="grid-fade">
        <div className="mx-auto max-w-4xl px-6 pt-16 pb-24 text-center">
          <Badge variant="accent" className="mx-auto">GPU rental, live today</Badge>
          <h1 className="mt-5 text-4xl font-semibold leading-tight tracking-tight sm:text-5xl">
            Dedicated GPUs, rented by the hour or booked upfront.
          </h1>
          <p className="mx-auto mt-5 max-w-2xl text-lg text-muted-foreground">
            TaskFlow gives you a real GPU instance in minutes — pay-as-you-go from a reloadable wallet, or lock in a
            fixed price with a day or week booking. No pre-paid AI credits, no idle infrastructure.
          </p>
          <div className="mt-8 flex justify-center gap-3">
            <Link href="/signup">
              <Button className="px-6 py-3 text-base">Create free account</Button>
            </Link>
            <Link href="/docs">
              <Button variant="secondary" className="px-6 py-3 text-base">
                Read the docs
              </Button>
            </Link>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-6 pb-24">
        <div className="grid gap-6 sm:grid-cols-3">
          {CAPABILITIES.map((c) => (
            <div key={c.title} className="panel-edge rounded-lg border border-border p-6">
              <h3 className="font-medium">{c.title}</h3>
              <p className="mt-2 text-sm text-muted-foreground">{c.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-6 pb-24">
        <h2 className="text-center text-2xl font-semibold">GPU catalog</h2>
        <p className="mx-auto mt-2 max-w-xl text-center text-sm text-muted-foreground">
          Base rates shown at Free-plan pricing. Pro and Max get 10% and 20% off every tier.
        </p>
        <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {GPU_CATALOG_REFERENCE.map((t) => (
            <div key={t.slug} className="panel-edge rounded-lg border border-border p-4">
              <p className="text-sm font-medium">{t.display_name}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {t.gpu} · {t.vram_gb}GB VRAM
              </p>
              <p className="text-xs text-muted-foreground">
                {t.vcpu} vCPU · {t.ram_gb}GB RAM
              </p>
              <p className="mt-3 font-mono-data text-lg font-semibold">
                £{t.base_price_gbp_per_hour.toFixed(2)}
                <span className="text-xs font-normal text-muted-foreground">/hr</span>
              </p>
            </div>
          ))}
        </div>
      </section>

      <section id="pricing" className="mx-auto max-w-6xl px-6 pb-28">
        <h2 className="text-center text-2xl font-semibold">Plans</h2>
        <p className="mx-auto mt-2 max-w-xl text-center text-sm text-muted-foreground">
          Every plan can rent GPUs pay-as-you-go. Pro and Max add booking, more concurrent rentals, more storage, and
          lower rates.
        </p>
        <div className="mt-10 grid gap-6 sm:grid-cols-3">
          {PLANS.map((plan) => (
            <Card key={plan.code} className={plan.highlighted ? "border-primary/50 ring-1 ring-primary/20" : ""}>
              <CardHeader>
                <CardTitle className="text-foreground">{plan.name}</CardTitle>
                <div className="mt-2 flex items-baseline gap-1">
                  <span className="text-3xl font-semibold">{plan.price}</span>
                  <span className="text-sm text-muted-foreground">/month</span>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">{plan.tagline}</p>
              </CardHeader>
              <CardContent>
                <ul className="space-y-2 text-sm">
                  {planFeatures(plan.code).map((f) => (
                    <li key={f} className="flex items-start gap-2 text-muted-foreground">
                      <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" />
                      {f}
                    </li>
                  ))}
                </ul>
                <Link href="/signup" className="mt-6 block">
                  <Button variant={plan.highlighted ? "primary" : "secondary"} className="w-full">
                    Choose {plan.name}
                  </Button>
                </Link>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      <footer className="border-t border-border py-8 text-center text-sm text-muted-foreground">
        TaskFlow · dedicated GPU infrastructure, without the babysitting.
      </footer>
    </div>
  );
}
