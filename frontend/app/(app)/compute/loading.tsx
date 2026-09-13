import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent } from "@/components/ui/card";

export default function Loading() {
  return (
    <div>
      <Skeleton className="h-7 w-32" />
      <Skeleton className="mt-2.5 h-4 w-72" />

      <Card className="mt-6">
        <CardContent className="flex items-center justify-between pt-5">
          <div>
            <Skeleton className="h-3.5 w-32" />
            <Skeleton className="mt-2 h-7 w-24" />
          </div>
          <Skeleton className="h-9 w-24" />
        </CardContent>
      </Card>

      <Card className="mt-6">
        <CardContent className="space-y-5 pt-6">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-28 rounded-md" />
            ))}
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-10 rounded-md" />
            ))}
          </div>
          <Skeleton className="h-10 w-full rounded-md" />
          <Skeleton className="h-24 w-full rounded-md" />
          <Skeleton className="h-11 w-full rounded-md" />
        </CardContent>
      </Card>

      <Skeleton className="mt-10 mb-3 h-4 w-24" />
      <div className="space-y-3">
        <Skeleton className="h-32 w-full rounded-lg" />
        <Skeleton className="h-32 w-full rounded-lg" />
      </div>
    </div>
  );
}
