import Link from "next/link";
import { Activity, Cpu, TrendingUp } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { Table, TableHead, TableBody, TableRow, TableHeaderCell, TableCell } from "@/components/ui/table";
import { SpendByBucketChart } from "./usage-metrics-chart";
import { formatGbp, cn } from "@/lib/utils";
import type { UsageSummary, UsagePeriod } from "@/lib/compute-client";

const PERIODS: { value: UsagePeriod; label: string }[] = [
  { value: "day", label: "Day" },
  { value: "month", label: "Month" },
  { value: "year", label: "Year" },
];

export function UsageMetricsSection({
  summary,
  period,
  basePath,
}: {
  summary: UsageSummary | null;
  period: UsagePeriod;
  /** Path to build period-switch links against, e.g. "/dashboard" */
  basePath: string;
}) {
  return (
    <div>
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-muted-foreground">Usage</h2>
        <div className="inline-flex items-center gap-1 rounded-md border border-border bg-muted/30 p-1">
          {PERIODS.map((p) => (
            <Link
              key={p.value}
              href={`${basePath}?period=${p.value}`}
              scroll={false}
              className={cn(
                "rounded-sm px-3 py-1.5 text-sm font-medium transition-colors",
                p.value === period ? "bg-card panel-edge text-foreground" : "text-muted-foreground hover:text-foreground"
              )}
            >
              {p.label}
            </Link>
          ))}
        </div>
      </div>

      {!summary ? (
        <div className="mt-3">
          <EmptyState icon={Activity} title="Usage data isn't available right now" description="This usually clears up on its own — the rest of the page still works." />
        </div>
      ) : (
        <div className="mt-3 space-y-4">
          <div className="grid gap-4 sm:grid-cols-3">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle>Total spend</CardTitle>
              </CardHeader>
              <CardContent className="font-mono-data text-2xl font-semibold">{formatGbp(summary.total_spend_micros)}</CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle>GPU hours</CardTitle>
              </CardHeader>
              <CardContent className="font-mono-data text-2xl font-semibold">{summary.total_gpu_hours.toFixed(1)}</CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle>Most-used GPU</CardTitle>
              </CardHeader>
              <CardContent>
                {summary.most_used_gpu_type ? (
                  <>
                    <p className="text-lg font-semibold">{summary.most_used_gpu_type.display_name}</p>
                    <p className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
                      <Cpu className="h-3 w-3" />
                      {summary.most_used_gpu_type.hours.toFixed(1)}h rented — ranked by time, not spend
                    </p>
                  </>
                ) : (
                  <p className="text-sm text-muted-foreground">No usage yet</p>
                )}
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="text-foreground">Spend over time</CardTitle>
            </CardHeader>
            <CardContent>
              {summary.total_spend_micros > 0 ? (
                <SpendByBucketChart buckets={summary.spend_by_bucket} period={period} />
              ) : (
                <EmptyState icon={TrendingUp} title="No spend in this period" />
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-foreground">By GPU tier</CardTitle>
            </CardHeader>
            <CardContent>
              {summary.by_gpu_type.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  Not enough data yet for a per-tier breakdown
                  {summary.total_spend_micros > 0 ? " — usage from before this feature shipped isn't linked to a tier." : "."}
                </p>
              ) : (
                <Table>
                  <TableHead>
                    <tr>
                      <TableHeaderCell>GPU tier</TableHeaderCell>
                      <TableHeaderCell>Hours</TableHeaderCell>
                      <TableHeaderCell>Spend</TableHeaderCell>
                      <TableHeaderCell>Share</TableHeaderCell>
                    </tr>
                  </TableHead>
                  <TableBody>
                    {summary.by_gpu_type.map((t) => (
                      <TableRow key={t.slug}>
                        <TableCell className="font-medium">
                          {t.display_name}
                          {summary.most_used_gpu_type?.slug === t.slug && (
                            <Badge variant="accent" className="ml-2">
                              Most used
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell className="font-mono-data">{t.hours.toFixed(1)}</TableCell>
                        <TableCell className="font-mono-data">{formatGbp(t.spend_micros, { precise: true })}</TableCell>
                        <TableCell className="font-mono-data text-muted-foreground">
                          {summary.total_spend_micros > 0 ? `${((t.spend_micros / summary.total_spend_micros) * 100).toFixed(0)}%` : "—"}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
