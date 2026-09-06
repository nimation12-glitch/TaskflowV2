import * as React from "react";
import { cn } from "@/lib/utils";

type Variant = "default" | "success" | "warning" | "danger" | "accent" | "outline";

const variantClasses: Record<Variant, string> = {
  default: "bg-muted text-foreground border-transparent",
  success: "bg-success/15 text-success border-success/30",
  warning: "bg-warning/15 text-warning border-warning/30",
  danger: "bg-danger/15 text-danger border-danger/30",
  accent: "bg-accent/15 text-accent border-accent/30",
  outline: "bg-transparent text-muted-foreground border-border",
};

export function Badge({
  className,
  variant = "default",
  children,
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & { variant?: Variant }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium leading-5",
        variantClasses[variant],
        className
      )}
      {...props}
    >
      {children}
    </span>
  );
}

/** A small dot-status variant, e.g. for "ACTIVE" / "REVOKED" rows in a dense list. */
export function StatusDot({ variant = "default", className }: { variant?: Variant; className?: string }) {
  const dotColor: Record<Variant, string> = {
    default: "bg-muted-foreground",
    success: "bg-success",
    warning: "bg-warning",
    danger: "bg-danger",
    accent: "bg-accent",
    outline: "bg-muted-foreground",
  };
  return <span className={cn("inline-block h-1.5 w-1.5 rounded-full", dotColor[variant], className)} />;
}
