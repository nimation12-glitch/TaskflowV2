import Link from "next/link";
import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Accordion, AccordionItem, AccordionTrigger, AccordionContent } from "@/components/ui/accordion";
import { LogoWordmark } from "@/components/logo-mark";
import { Reveal } from "@/components/reveal";
import { PLAN_LIMITS, type PlanCode } from "@/lib/compute-types";
import { GPU_CATALOG_REFERENCE } from "@/lib/gpu-catalog-reference";

const PLANS: { code: PlanCode; name: string; price: string; tagline: string; highlighted?: boolean }[] = [
  { code: "FREE", name: "Free", price: "£0", tagline: "1 concurrent rental, 50GB storage, pay as you go." },
  { code: "PRO", name: "Pro", price: "£35", tagline: "3 concurrent rentals, 250GB storage, and booking.", highlighted: true },
  { code: "ULTRA", name: "Ultra", price: "£65", tagline: "6 concurrent rentals, 500GB storage, 14-day bookings." },
  { code: "MAX", name: "Max", price: "£100", tagline: "10 concurrent rentals, 1TB storage, everything unlocked." },
];

function planFeatures(code: PlanCode): string[] {
  const l = PLAN_LIMITS[code];
  const bookingNote = l.bookingAllowed ? "Pay-as-you-go or upfront day/week booking" : "Pay-as-you-go only";
  return [
    `${l.concurrentRentals} concurrent rental${l.concurrentRentals > 1 ? "s" : ""}`,
    `${l.maxStorageGb >= 1024 ? "1TB" : `${l.maxStorageGb}GB`} storage max`,
    code === "FREE" ? "4-hour max session length" : `${l.maxBookingDays}-day max rental length`,
    "All GPU time billed from your wallet — no included compute credits",
    bookingNote,
    `${l.queuePriority} queue priority`,
  ];
}

const CAPABILITIES = [
  { title: "Real GPUs, by the hour", body: "T4, L4, A10G, L40S, A100 and H100 configurations, provisioned in minutes. SSH in and run whatever you need — training, inference, rendering, whatever the job is." },
  { title: "Pay for what you use", body: "A reloadable wallet meters your rental to the hour, or lock in a fixed price upfront with a day or week booking. Fixed list prices — the regional premium is shown before you pay." },
  { title: "No infrastructure babysitting", body: "Auto-stop on low balance instead of losing your instance. Auto-terminate at the end of a booked period. You keep control, we keep it predictable." },
];

const HOW_IT_WORKS = [
  { step: "1", title: "Add an SSH key", body: "Paste your public key once — it's how you'll connect to every rental after this." },
  { step: "2", title: "Pick a GPU and pay how you like", body: "Choose a configuration and storage size, then rent by the hour from your wallet or book a fixed period upfront. You pick the GPU; the best region is picked for you." },
  { step: "3", title: "SSH in and get to work", body: "Your instance boots in 1-2 minutes. Copy the connection string and you're on the box." },
];

const USE_CASES = ["Model fine-tuning & training", "Stable Diffusion & image generation", "Data processing pipelines", "3D & game rendering", "Academic research"];

const FAQ = [
  {
    q: "What's the difference between pay-as-you-go and booking?",
    a: "Pay-as-you-go debits your GPU wallet by the hour while a rental runs, and you can stop it any time. Booking charges the full cost of a fixed 1-day or 1-week period upfront, and the instance auto-terminates when that period ends. Booking is available on Pro, Ultra and Max.",
  },
  {
    q: "What happens if my wallet runs out mid-rental?",
    a: "The rental auto-stops rather than terminating — your instance and its data are preserved, just paused. Top up and start it again whenever you're ready.",
  },
  {
    q: "What happens when a booking expires?",
    a: "You'll see a warning starting an hour before expiry. When the period ends, the instance auto-terminates. Extending a booking is coming soon.",
  },
  {
    q: "How is storage priced?",
    a: "The first 100GB is included in the base hourly rate. Extra storage adds £0.03/hour for every 100GB block beyond that, shown live as you configure a rental.",
  },
  {
    q: "What regions are available?",
    a: "Six launch regions: US East and US West, Stockholm, London, Frankfurt, and Tokyo. You pick a GPU and optionally a location (UK, Europe, North America, Asia) — we automatically launch in the best region for it, and the exact regional premium is shown before you pay.",
  },
];

export default function LandingPage() {
  return (
    <div className="min-h-screen">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-6 py-6">
        <LogoWordmark size={26} />
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
            Dedicated GPUs,{" "}
            <span className="bg-gradient-to-r from-primary via-primary to-accent bg-clip-text text-transparent">
              rented by the hour
            </span>{" "}
            or booked upfront.
          </h1>
          <p className="mx-auto mt-5 max-w-2xl text-lg text-muted-foreground">
            TaskFlow gives you a real GPU instance in minutes — pay-as-you-go from a reloadable wallet, or lock in a
            fixed price with a day or week booking. No pre-paid AI credits, no idle infrastructure.
          </p>
          <div className="mt-8 flex flex-wrap justify-center gap-3">
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
          {CAPABILITIES.map((c, i) => (
            <Reveal key={c.title} delayMs={i * 100}>
              <div className="panel-edge rounded-lg border border-border p-6 transition-transform duration-300 hover:-translate-y-1 hover:border-primary/30">
                <h3 className="font-medium">{c.title}</h3>
                <p className="mt-2 text-sm text-muted-foreground">{c.body}</p>
              </div>
            </Reveal>
          ))}
        </div>
      </section>

      <section className="mx-auto max-w-5xl px-6 pb-24">
        <h2 className="text-center text-2xl font-semibold">How it works</h2>
        <div className="mt-10 grid gap-10 sm:grid-cols-3">
          {HOW_IT_WORKS.map((s, i) => (
            <Reveal key={s.step} delayMs={i * 120}>
              <div>
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-gradient-to-br from-primary/20 to-accent/10 font-mono-data text-sm font-semibold text-primary">
                  {s.step}
                </div>
                <h3 className="mt-4 font-medium">{s.title}</h3>
                <p className="mt-1.5 text-sm text-muted-foreground">{s.body}</p>
              </div>
            </Reveal>
          ))}
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-6 pb-24">
        <h2 className="text-center text-2xl font-semibold">GPU catalog</h2>
        <p className="mx-auto mt-2 max-w-xl text-center text-sm text-muted-foreground">
          34 configurations across six GPU families, at fixed list prices — plans buy access, never discounts. Full
          catalogue (with regional pricing) is in the app.
        </p>
        <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {GPU_CATALOG_REFERENCE.map((t, i) => (
            <Reveal key={t.family} delayMs={i * 80}>
              <div className="panel-edge rounded-lg border border-border p-4 transition-transform duration-300 hover:-translate-y-1 hover:border-primary/30">
                <p className="text-sm font-medium">{t.family}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {t.vram_gb}GB VRAM
                </p>
                <p className="text-xs text-muted-foreground">
                  {t.vcpu} vCPU · {t.ram_gb}GB RAM
                </p>
                <p className="mt-3 font-mono-data text-lg font-semibold">
                  £{t.from_price_gbp_per_hour.toFixed(2)}
                  <span className="text-xs font-normal text-muted-foreground">/hr</span>
                </p>
                <p className="text-xs text-muted-foreground">{t.note}</p>
              </div>
            </Reveal>
          ))}
        </div>
      </section>

      <section id="pricing" className="mx-auto max-w-6xl px-6 pb-28">
        <h2 className="text-center text-2xl font-semibold">Plans</h2>
        <p className="mx-auto mt-2 max-w-xl text-center text-sm text-muted-foreground">
          Every plan rents the full catalogue pay-as-you-go. Pro and above add booking, more concurrent rentals and
          more storage — GPU prices stay fixed either way.
        </p>
        <div className="mt-10 grid gap-6 sm:grid-cols-3">
          {PLANS.map((plan, i) => (
            <Reveal key={plan.code} delayMs={i * 100}>
              <Card
                className={
                  (plan.highlighted ? "border-primary/50 ring-1 ring-primary/20 " : "") +
                  "transition-transform duration-300 hover:-translate-y-1"
                }
              >
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
            </Reveal>
          ))}
        </div>
      </section>

      <section className="mx-auto max-w-4xl px-6 pb-24 text-center">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Built for</p>
        <div className="mt-4 flex flex-wrap justify-center gap-2">
          {USE_CASES.map((u) => (
            <span key={u} className="rounded-full border border-border px-3 py-1.5 text-sm text-muted-foreground">
              {u}
            </span>
          ))}
        </div>
      </section>

      <section className="mx-auto max-w-3xl px-6 pb-28">
        <h2 className="text-center text-2xl font-semibold">Frequently asked</h2>
        <div className="mt-8">
          <Accordion type="single" collapsible>
            {FAQ.map((item) => (
              <AccordionItem key={item.q} value={item.q}>
                <AccordionTrigger>{item.q}</AccordionTrigger>
                <AccordionContent>{item.a}</AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        </div>
      </section>

      <footer className="border-t border-border py-8 text-center text-sm text-muted-foreground">
        <p>TaskFlow · dedicated GPU infrastructure, without the babysitting.</p>
        <div className="mt-3 flex justify-center gap-4 text-xs">
          <Link href="/terms" className="hover:text-foreground">
            Terms of Service
          </Link>
          <Link href="/privacy" className="hover:text-foreground">
            Privacy Policy
          </Link>
          <Link href="/docs" className="hover:text-foreground">
            Docs
          </Link>
        </div>
      </footer>
    </div>
  );
}
