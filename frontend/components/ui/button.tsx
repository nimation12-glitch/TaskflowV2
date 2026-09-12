import * as React from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

type Variant = "primary" | "secondary" | "ghost" | "danger" | "outline";
type Size = "default" | "sm" | "lg" | "icon";

const variantClasses: Record<Variant, string> = {
  primary: "bg-primary text-primary-foreground shadow-md shadow-primary/25 hover:shadow-lg hover:shadow-primary/30 hover:brightness-110 active:brightness-95",
  secondary: "bg-muted text-foreground shadow-sm shadow-black/10 hover:bg-muted/70 border border-border",
  ghost: "hover:bg-muted/60",
  danger: "bg-danger text-white shadow-md shadow-danger/25 hover:shadow-lg hover:shadow-danger/30 hover:brightness-110 active:brightness-95",
  outline: "border border-border bg-transparent hover:bg-muted/40",
};

const sizeClasses: Record<Size, string> = {
  default: "h-10 px-4 text-sm",
  sm: "h-8 px-3 text-xs",
  lg: "h-11 px-6 text-base",
  icon: "h-9 w-9 shrink-0",
};

export const Button = React.forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size; loading?: boolean }
>(({ className, variant = "primary", size = "default", loading, disabled, children, ...props }, ref) => {
  return (
    <button
      ref={ref}
      className={cn(
        "inline-flex items-center justify-center gap-2 rounded-md font-semibold transition-all duration-150 disabled:opacity-50 disabled:pointer-events-none",
        variantClasses[variant],
        sizeClasses[size],
        className
      )}
      disabled={disabled || loading}
      {...props}
    >
      {loading && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
      {children}
    </button>
  );
});
Button.displayName = "Button";
