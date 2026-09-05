import { backendJson } from "@/lib/backend-client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

type UsageSummary = {
  requests: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  total_charge_micros: number;
};

type UsageEvent = {
  id: string;
  status: string;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  charge_micros: number;
  latency_ms: number | null;
  created_at: string;
};

function formatGbp(micros: number): string {
  return `£${(micros / 1_000_000).toFixed(4)}`;
}

export default async function UsagePage() {
  const [summary, events] = await Promise.all([
    backendJson<UsageSummary>("/usage/summary"),
    backendJson<UsageEvent[]>("/usage/events?limit=50"),
  ]);

  return (
    <div>
      <h1 className="text-2xl font-semibold">Usage</h1>

      <div className="mt-6 grid gap-4 sm:grid-cols-4">
        <Card>
          <CardHeader>
            <CardTitle>Requests</CardTitle>
          </CardHeader>
          <CardContent className="font-mono-data text-2xl font-semibold">{summary.requests}</CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Input tokens</CardTitle>
          </CardHeader>
          <CardContent className="font-mono-data text-2xl font-semibold">{summary.input_tokens.toLocaleString()}</CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Output tokens</CardTitle>
          </CardHeader>
          <CardContent className="font-mono-data text-2xl font-semibold">{summary.output_tokens.toLocaleString()}</CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Total spend</CardTitle>
          </CardHeader>
          <CardContent className="font-mono-data text-2xl font-semibold">{formatGbp(summary.total_charge_micros)}</CardContent>
        </Card>
      </div>

      <h2 className="mt-10 text-sm font-medium text-muted-foreground">Recent requests</h2>
      <div className="mt-3 overflow-hidden rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
            <tr>
              <th className="p-3">Time</th>
              <th className="p-3">Status</th>
              <th className="p-3">Tokens</th>
              <th className="p-3">Charge</th>
              <th className="p-3">Latency</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {events.length === 0 && (
              <tr>
                <td className="p-4 text-muted-foreground" colSpan={5}>
                  No requests yet — make a call to <code>/v1/chat/completions</code> to see it here.
                </td>
              </tr>
            )}
            {events.map((e) => (
              <tr key={e.id} className="font-mono-data">
                <td className="p-3">{new Date(e.created_at).toLocaleString()}</td>
                <td className="p-3">{e.status}</td>
                <td className="p-3">{e.total_tokens}</td>
                <td className="p-3">{formatGbp(e.charge_micros)}</td>
                <td className="p-3">{e.latency_ms ? `${e.latency_ms}ms` : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
