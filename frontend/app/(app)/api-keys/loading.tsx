import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <div>
      <Skeleton className="h-7 w-32" />
      <Skeleton className="mt-2.5 h-4 w-96" />
      <div className="mt-6 flex gap-2">
        <Skeleton className="h-10 flex-1 rounded-md" />
        <Skeleton className="h-10 w-32 rounded-md" />
      </div>
      <Skeleton className="mt-6 h-40 w-full rounded-lg" />
    </div>
  );
}
