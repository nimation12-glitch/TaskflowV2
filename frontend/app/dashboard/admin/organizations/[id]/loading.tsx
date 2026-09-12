import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <div>
      <Skeleton className="h-4 w-32" />
      <Skeleton className="mt-3 h-6 w-48" />
      <Skeleton className="mt-1.5 h-3 w-64" />
      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <div className="space-y-6">
          <Skeleton className="h-56 rounded-lg" />
          <Skeleton className="h-40 rounded-lg" />
        </div>
        <div className="space-y-6">
          <Skeleton className="h-48 rounded-lg" />
          <Skeleton className="h-48 rounded-lg" />
        </div>
      </div>
    </div>
  );
}
