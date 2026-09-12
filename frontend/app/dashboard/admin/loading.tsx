import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent } from "@/components/ui/card";

export default function Loading() {
  return (
    <div className="max-w-2xl">
      <Card>
        <CardContent className="space-y-5 pt-6">
          <div className="flex items-center justify-between">
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-5 w-16 rounded-full" />
          </div>
          <Skeleton className="h-16 w-full rounded-md" />
          <Skeleton className="h-20 w-full rounded-md" />
        </CardContent>
      </Card>
    </div>
  );
}
