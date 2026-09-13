import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <div className="max-w-2xl">
      <Skeleton className="h-7 w-20" />
      <Skeleton className="mt-2.5 h-4 w-24" />
      <Skeleton className="mt-6 h-9 w-40" />
      <Skeleton className="mt-8 h-4 w-20" />
      <div className="mt-3 space-y-0 overflow-hidden rounded-lg border border-border">
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex items-center justify-between border-b border-border p-4 last:border-b-0">
            <div className="flex items-center gap-3">
              <Skeleton className="h-9 w-9 rounded-full" />
              <div>
                <Skeleton className="h-4 w-32" />
                <Skeleton className="mt-1.5 h-3 w-20" />
              </div>
            </div>
            <Skeleton className="h-5 w-16 rounded-full" />
          </div>
        ))}
      </div>
    </div>
  );
}
