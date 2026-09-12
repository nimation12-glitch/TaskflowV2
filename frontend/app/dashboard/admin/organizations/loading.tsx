import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <div>
      <Skeleton className="h-4 w-32" />
      <Skeleton className="mt-4 h-10 w-64 rounded-md" />
      <Skeleton className="mt-4 h-80 w-full rounded-lg" />
    </div>
  );
}
