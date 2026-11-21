import Link from "next/link";
import { LifeBuoy, Mail, BookOpen, Cpu, CreditCard, FolderOpen } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Accordion, AccordionItem, AccordionTrigger, AccordionContent } from "@/components/ui/accordion";

const TOPICS = [
  { icon: Cpu, title: "Renting a GPU", href: "/compute", body: "Browse the catalogue, then pick the GPU in a workspace's setup." },
  { icon: CreditCard, title: "Billing & plans", href: "/billing", body: "Compare plans, see your rates, and manage your subscription." },
  { icon: FolderOpen, title: "Workspaces", href: "/compute?tab=workspaces", body: "Create a machine, attach a key, and connect over SSH." },
];

const FAQ = [
  {
    q: "How do I connect to a running workspace?",
    a: "Open the Workspaces tab on the Compute page and press Connect on the card. It shows the SSH command and your machine's public IP. Keys are created during workspace setup — the wizard generates one for you, or you can attach a key you already have.",
  },
  {
    q: "What happens if my wallet runs out mid-rental?",
    a: "The rental auto-stops rather than terminating — your instance and its data are preserved, just paused. Top up from the Compute page and start it again.",
  },
  {
    q: "Can I change my plan without losing my workspaces?",
    a: "Yes — upgrading or downgrading from the Billing page doesn't affect running workspaces or their storage. If a downgrade puts you over your new concurrent-GPU limit, stop one to get back under it.",
  },
];

export default function HelpPage() {
  return (
    <div className="max-w-3xl">
      <div className="flex items-center gap-2.5">
        <LifeBuoy className="h-6 w-6 text-primary" />
        <h1 className="text-2xl font-semibold tracking-tight">Help & documentation</h1>
      </div>
      <p className="mt-1.5 text-sm text-muted-foreground">Common questions, quick links, and how to reach us.</p>

      <div className="mt-6 grid gap-4 sm:grid-cols-3">
        {TOPICS.map((t) => (
          <Link key={t.title} href={t.href}>
            <Card className="h-full transition-transform hover:-translate-y-0.5">
              <CardContent className="pt-5">
                <t.icon className="h-5 w-5 text-primary" strokeWidth={1.75} />
                <p className="mt-3 text-sm font-medium">{t.title}</p>
                <p className="mt-1 text-xs text-muted-foreground">{t.body}</p>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>

      <h2 className="mt-10 text-sm font-medium text-muted-foreground">Frequently asked</h2>
      <Card className="mt-3">
        <CardContent className="pt-2">
          <Accordion type="single" collapsible>
            {FAQ.map((item) => (
              <AccordionItem key={item.q} value={item.q}>
                <AccordionTrigger>{item.q}</AccordionTrigger>
                <AccordionContent>{item.a}</AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        </CardContent>
      </Card>

      <Card className="mt-6">
        <CardContent className="flex items-center justify-between pt-5">
          <div>
            <p className="text-sm font-medium">Still stuck?</p>
            <p className="mt-0.5 text-xs text-muted-foreground">We usually reply within a day.</p>
          </div>
          <a href="mailto:support@taskflow.web-agent.org" className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline">
            <Mail className="h-4 w-4" />
            support@taskflow.web-agent.org
          </a>
        </CardContent>
      </Card>

      <p className="mt-6 flex items-center gap-1.5 text-xs text-muted-foreground">
        <BookOpen className="h-3.5 w-3.5" />
        Questions about a charge? See{" "}
        <Link href="/billing" className="text-primary hover:underline">
          Billing
        </Link>
        .
      </p>
    </div>
  );
}
