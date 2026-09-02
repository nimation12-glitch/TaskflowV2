"use client";

/** Docs — quickstart and API reference for the TaskFlow gateway. */

import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatGBP } from "@/lib/money";
import type { MeResponse } from "@/types/taskflow";
import type { DashboardView } from "./dashboard-shell";
import { KeyRound, Terminal, Copy, Check, ArrowRight } from "lucide-react";

function CodeBlock({ title, code }: { title: string; code: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch { /* clipboard unavailable */ }
  }
  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-slate-950">
      <div className="flex items-center justify-between border-b border-white/10 px-3.5 py-2">
        <span className="text-xs font-medium text-slate-400">{title}</span>
        <Button variant="ghost" size="sm" className="h-7 px-2 text-slate-400 hover:bg-white/10 hover:text-white" onClick={copy}>
          {copied ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
        </Button>
      </div>
      <pre className="overflow-x-auto p-4 text-[12.5px] leading-relaxed text-slate-300">{code}</pre>
    </div>
  );
}

export function DocsView({ me, onNavigate }: { me: MeResponse; onNavigate: (v: DashboardView) => void }) {
  const key = "tf_live_YOUR_API_KEY";
  const base = typeof window !== "undefined" ? window.location.origin : "https://api.taskflow.web-agent.org";

  const curlExample = `curl ${base}/api/v1/chat/completions \\
  -H "Authorization: Bearer ${key}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "taskflow-mini",
    "messages": [
      {"role": "user", "content": "Summarise the TaskFlow platform in one line."}
    ]
  }'`;

  const pythonExample = `import requests

resp = requests.post(
    "${base}/api/v1/chat/completions",
    headers={"Authorization": "Bearer ${key}"},
    json={
        "model": "taskflow-mini",
        "messages": [{"role": "user", "content": "Hello TaskFlow!"}],
    },
    timeout=60,
)
data = resp.json()
print(data["choices"][0]["message"]["content"])
print("charged (GBP):", data["taskflow"]["charge_micros"] / 1_000_000)`;

  const nodeExample = `const res = await fetch("${base}/api/v1/chat/completions", {
  method: "POST",
  headers: {
    Authorization: "Bearer ${key}",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    model: "taskflow-chat",
    messages: [{ role: "user", content: "Hello TaskFlow!" }],
  }),
});
const data = await res.json();
console.log(data.choices[0].message.content);`;

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-xl font-bold tracking-tight text-slate-900">Documentation</h2>
        <p className="text-sm text-slate-500">Make your first call to the TaskFlow AI gateway in minutes</p>
      </div>

      {/* Quickstart */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base"><Terminal className="h-4.5 w-4.5 text-emerald-600" /> Quickstart</CardTitle>
          <CardDescription>Three steps from zero to your first AI response</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-3">
            {[
              { n: "1", title: "Create an API key", body: "Keys start with tf_live_ and are shown once.", action: () => onNavigate("api-keys"), actionLabel: "Go to API keys" },
              { n: "2", title: "Pick a model", body: "Choose any model entitled to your plan.", action: () => onNavigate("models"), actionLabel: "Browse models" },
              { n: "3", title: "Call the API", body: "OpenAI-compatible chat completions endpoint.", action: undefined, actionLabel: undefined },
            ].map((s) => (
              <div key={s.n} className="rounded-xl border border-slate-200 p-4">
                <div className="mb-2 flex h-7 w-7 items-center justify-center rounded-full bg-emerald-600 text-xs font-bold text-white">{s.n}</div>
                <div className="text-sm font-semibold text-slate-900">{s.title}</div>
                <p className="mt-1 text-xs text-slate-500">{s.body}</p>
                {s.action && (
                  <button className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-emerald-700 hover:text-emerald-800" onClick={s.action}>
                    {s.actionLabel} <ArrowRight className="h-3 w-3" />
                  </button>
                )}
              </div>
            ))}
          </div>

          <div className="rounded-lg border border-slate-200 bg-slate-50 p-3.5 text-sm text-slate-600">
            <span className="font-medium text-slate-800">Your plan:</span> {me.subscription?.planName ?? "—"} ·
            <span className="font-medium text-slate-800"> balance:</span> {formatGBP(me.credits.balanceMicros)} ·
            <span className="font-medium text-slate-800"> rate limit:</span> {me.subscription?.rateLimitPerMinute ?? "—"} requests/minute
          </div>
        </CardContent>
      </Card>

      {/* Endpoint */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline" className="border-emerald-300 bg-emerald-50 font-mono text-emerald-700">POST</Badge>
            <code className="text-sm font-semibold text-slate-900">/api/v1/chat/completions</code>
            <Badge variant="outline" className="border-slate-200 text-slate-500">OpenAI-compatible</Badge>
          </div>
          <CardDescription>
            Chat completion through the TaskFlow gateway. Authentication, entitlements, rate limiting,
            metering and credit deduction happen automatically.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <CodeBlock title="cURL" code={curlExample} />
          <div className="grid gap-5 lg:grid-cols-2">
            <CodeBlock title="Python" code={pythonExample} />
            <CodeBlock title="Node.js (fetch)" code={nodeExample} />
          </div>
        </CardContent>
      </Card>

      {/* Reference */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Request</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div>
              <div className="font-medium text-slate-800">Headers</div>
              <div className="mt-1 space-y-1 text-slate-600">
                <div><code className="rounded bg-slate-100 px-1.5 py-0.5 text-xs">Authorization</code> — Bearer <code className="rounded bg-slate-100 px-1.5 py-0.5 text-xs">tf_live_…</code> (required)</div>
                <div><code className="rounded bg-slate-100 px-1.5 py-0.5 text-xs">Content-Type: application/json</code></div>
              </div>
            </div>
            <div>
              <div className="font-medium text-slate-800">Body</div>
              <div className="mt-1 space-y-1 text-slate-600">
                <div><code className="rounded bg-slate-100 px-1.5 py-0.5 text-xs">model</code> — model ID, e.g. taskflow-mini (required)</div>
                <div><code className="rounded bg-slate-100 px-1.5 py-0.5 text-xs">messages</code> — array of {"{ role, content }"}; role ∈ system | user | assistant (required)</div>
                <div><code className="rounded bg-slate-100 px-1.5 py-0.5 text-xs">temperature</code> — 0–2 (optional)</div>
                <div><code className="rounded bg-slate-100 px-1.5 py-0.5 text-xs">max_tokens</code> — cap output length (optional)</div>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Response &amp; errors</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div>
              <div className="font-medium text-slate-800">Successful response</div>
              <div className="mt-1 text-slate-600">
                OpenAI-shaped object plus a <code className="rounded bg-slate-100 px-1.5 py-0.5 text-xs">taskflow</code> block:
                request id, provider, <code className="rounded bg-slate-100 px-1.5 py-0.5 text-xs">charge_micros</code> (what this call cost,
                in millionths of £1) and your remaining balance.
              </div>
            </div>
            <div>
              <div className="font-medium text-slate-800">Error codes</div>
              <div className="mt-1 space-y-1 text-slate-600">
                <div><Badge variant="outline" className="mr-1.5 font-mono text-[11px]">401</Badge> missing/invalid API key</div>
                <div><Badge variant="outline" className="mr-1.5 font-mono text-[11px]">402</Badge> credits exhausted or subscription inactive</div>
                <div><Badge variant="outline" className="mr-1.5 font-mono text-[11px]">403</Badge> model not entitled on your plan</div>
                <div><Badge variant="outline" className="mr-1.5 font-mono text-[11px]">429</Badge> rate/concurrency limit — honour <code className="rounded bg-slate-100 px-1.5 py-0.5 text-xs">Retry-After</code></div>
                <div><Badge variant="outline" className="mr-1.5 font-mono text-[11px]">503</Badge> provider temporarily unavailable (never billed)</div>
              </div>
            </div>
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-500">
              Failed requests never reach a provider and are never billed. Usage is only deducted for
              successful upstream responses.
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Models listing endpoint */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline" className="border-slate-300 bg-slate-50 font-mono text-slate-600">GET</Badge>
            <code className="text-sm font-semibold text-slate-900">/api/v1/models</code>
            <Badge variant="outline" className="border-slate-200 text-slate-500">list entitled models</Badge>
          </div>
          <CardDescription>
            Returns the models your key may call, with TaskFlow pricing metadata.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <CodeBlock
            title="cURL"
            code={`curl ${base}/api/v1/models -H "Authorization: Bearer ${key}"`}
          />
        </CardContent>
      </Card>

      <div className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-600">
        <KeyRound className="h-4.5 w-4.5 shrink-0 text-emerald-600" />
        <span>
          Keep keys server-side. Never ship a <code className="rounded bg-slate-100 px-1 py-0.5 text-xs">tf_live_</code> key to a browser or mobile app — proxy through your backend instead.
        </span>
      </div>
    </div>
  );
}
