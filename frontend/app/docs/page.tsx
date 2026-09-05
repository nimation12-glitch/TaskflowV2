export default function DocsPage() {
  return (
    <div className="mx-auto max-w-2xl px-6 py-16">
      <h1 className="text-2xl font-semibold">API documentation</h1>
      <p className="mt-4 text-sm text-muted-foreground">
        TaskFlow exposes an OpenAI-compatible API. Create an API key from your dashboard, then:
      </p>
      <pre className="mt-4 overflow-x-auto rounded-lg border border-border bg-muted/40 p-4 text-xs">
{`curl ${process.env.NEXT_PUBLIC_API_BASE_URL ?? "https://api.taskflow.web-agent.org"}/v1/chat/completions \\
  -H "Authorization: Bearer tf_live_..." \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "llama-3-8b",
    "messages": [{"role": "user", "content": "Hello"}]
  }'`}
      </pre>
      <p className="mt-4 text-sm text-muted-foreground">
        See <code>/dashboard/models</code> for which models your plan can access.
      </p>
    </div>
  );
}
