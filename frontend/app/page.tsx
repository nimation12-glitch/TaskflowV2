import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const PLANS = [
  {
    name: "Free",
    price: "£0",
    credit: "£2",
    rpm: "20 requests/min",
    features: ["Basic model access", "API key management", "Community support"],
  },
  {
    name: "Pro",
    price: "£30",
    credit: "£15",
    rpm: "100 requests/min",
    features: ["Broader model access", "Usage analytics", "GPU rental capability"],
    highlighted: true,
  },
  {
    name: "Max",
    price: "£90",
    credit: "£50",
    rpm: "300 requests/min",
    features: ["Premium model access", "Highest compute priority", "Advanced analytics"],
  },
];

const CAPABILITIES = [
  { title: "One API, many models", body: "Call chat models from multiple providers through a single OpenAI-compatible endpoint. Switch models without rewriting integration code." },
  { title: "Usage you can actually see", body: "Every request is metered down to the input token. Credits show exactly what you've spent and what's left, no surprise invoices." },
  { title: "GPU compute, on demand", body: "Rent dedicated GPU capacity by the hour when you need to deploy your own model, and stop paying the moment you shut it down." },
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

      <section className="mx-auto max-w-4xl px-6 pt-16 pb-24 text-center">
        <h1 className="text-4xl font-semibold leading-tight tracking-tight sm:text-5xl">
          Your API keys, models, and GPU spend — in one place.
        </h1>
        <p className="mx-auto mt-5 max-w-2xl text-lg text-muted-foreground">
          TaskFlow is the control plane between your application and AI infrastructure. Subscribe, get monthly
          credits, call models, and rent GPU compute when you need to run your own.
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
      </section>

      <section className="mx-auto max-w-6xl px-6 pb-24">
        <div className="grid gap-6 sm:grid-cols-3">
          {CAPABILITIES.map((c) => (
            <div key={c.title} className="rounded-lg border border-border p-6">
              <h3 className="font-medium">{c.title}</h3>
              <p className="mt-2 text-sm text-muted-foreground">{c.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section id="pricing" className="mx-auto max-w-6xl px-6 pb-28">
        <h2 className="text-center text-2xl font-semibold">Plans</h2>
        <p className="mx-auto mt-2 max-w-xl text-center text-sm text-muted-foreground">
          Every plan includes a monthly credit allowance, not unlimited usage. Once it's used, top up or upgrade.
        </p>
        <div className="mt-10 grid gap-6 sm:grid-cols-3">
          {PLANS.map((plan) => (
            <Card key={plan.name} className={plan.highlighted ? "border-primary" : ""}>
              <CardHeader>
                <CardTitle className="text-foreground">{plan.name}</CardTitle>
                <div className="mt-2 flex items-baseline gap-1">
                  <span className="text-3xl font-semibold">{plan.price}</span>
                  <span className="text-sm text-muted-foreground">/month</span>
                </div>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground">{plan.credit} monthly AI credit · {plan.rpm}</p>
                <ul className="mt-4 space-y-2 text-sm">
                  {plan.features.map((f) => (
                    <li key={f} className="text-muted-foreground">
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
        TaskFlow · built for developers who need AI infrastructure, not another dashboard to babysit.
      </footer>
    </div>
  );
}
