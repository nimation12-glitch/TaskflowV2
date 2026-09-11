import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent } from "@/components/ui/card";

export default function Loading() {
  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <Skeleton className="h-7 w-28" />
        <Skeleton className="mt-2.5 h-4 w-56" />
      </div>
      <Card>
        <CardContent className="space-y-4 pt-6">
          <Skeleton className="h-5 w-24" />
          <Skeleton className="h-20 w-full rounded-lg" />
          <Skeleton className="h-16 w-full rounded-lg" />
        </CardContent>
      </Card>
      <Card>
        <CardContent className="flex items-center justify-between pt-6">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-9 w-24" />
        </CardContent>
      </Card>
    </div>
  );
}
