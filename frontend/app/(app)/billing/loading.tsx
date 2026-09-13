import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent } from "@/components/ui/card";

export default function Loading() {
  return (
    <div className="max-w-3xl">
      <Skeleton className="h-7 w-28" />
      <Skeleton className="mt-2.5 h-4 w-96" />

      <Card className="mt-6">
        <CardContent className="pt-6">
          <Skeleton className="h-5 w-24" />
          <Skeleton className="mt-2 h-4 w-48" />
          <Skeleton className="mt-3 h-3 w-64" />
        </CardContent>
      </Card>

      <Skeleton className="mt-10 h-4 w-16" />
      <Skeleton className="mt-1 h-3 w-72" />
      <div className="mt-3 grid gap-4 sm:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-64 rounded-lg" />
        ))}
      </div>
    </div>
  );
}
