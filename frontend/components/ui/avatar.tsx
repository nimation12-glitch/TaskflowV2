import { cn } from "@/lib/utils";
import { initials } from "@/lib/utils";

const PALETTE = [
  "bg-primary/20 text-primary",
  "bg-accent/20 text-accent",
  "bg-success/20 text-success",
  "bg-warning/20 text-warning",
];

function paletteFor(seed: string) {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  return PALETTE[hash % PALETTE.length];
}

export function Avatar({
  label,
  size = "md",
  className,
}: {
  /** Name, email, or id used to derive initials and a stable color. */
  label: string;
  size?: "sm" | "md" | "lg";
  className?: string;
}) {
  const sizeClasses = { sm: "h-7 w-7 text-[10px]", md: "h-9 w-9 text-xs", lg: "h-12 w-12 text-sm" }[size];
  return (
    <div
      className={cn(
        "flex shrink-0 items-center justify-center rounded-full font-semibold",
        sizeClasses,
        paletteFor(label),
        className
      )}
      aria-hidden
    >
      {initials(label)}
    </div>
  );
}
