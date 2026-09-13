"use client";

import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import { formatGbp } from "@/lib/utils";
import type { UsagePeriod } from "@/lib/compute-client";

function bucketLabel(iso: string, period: UsagePeriod): string {
  const d = new Date(iso);
  if (period === "day") return d.toLocaleTimeString("en-GB", { hour: "2-digit" });
  if (period === "year") return d.toLocaleDateString("en-GB", { month: "short" });
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

function ChartTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-md border border-border bg-popover px-3 py-2 text-xs shadow-lg">
      <p className="mb-1 text-muted-foreground">{label}</p>
      <p className="font-mono-data font-medium">{formatGbp(payload[0].value, { precise: true })}</p>
    </div>
  );
}

export function SpendByBucketChart({
  buckets,
  period,
}: {
  buckets: { bucket_start: string; spend_micros: number }[];
  period: UsagePeriod;
}) {
  const data = buckets.map((b) => ({ label: bucketLabel(b.bucket_start, period), spend: b.spend_micros }));

  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
        <XAxis
          dataKey="label"
          tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
          tickLine={false}
          axisLine={false}
          minTickGap={period === "day" ? 16 : 24}
        />
        <YAxis
          tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
          tickLine={false}
          axisLine={false}
          tickFormatter={(v) => `£${(v / 1_000_000).toFixed(0)}`}
          width={48}
        />
        <Tooltip content={<ChartTooltip />} cursor={{ fill: "hsl(var(--muted) / 0.3)" }} />
        <Bar dataKey="spend" fill="hsl(var(--primary))" radius={[3, 3, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}
