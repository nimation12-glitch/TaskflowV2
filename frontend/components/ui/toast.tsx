"use client";

import * as React from "react";
import * as ToastPrimitive from "@radix-ui/react-toast";
import { X, CheckCircle2, AlertTriangle, XCircle, Info } from "lucide-react";
import { cn } from "@/lib/utils";

export const ToastProvider = ToastPrimitive.Provider;

export function ToastViewport({ className, ...props }: React.ComponentPropsWithoutRef<typeof ToastPrimitive.Viewport>) {
  return (
    <ToastPrimitive.Viewport
      className={cn(
        "fixed bottom-0 right-0 z-[100] flex w-full max-w-sm flex-col gap-2 p-4 outline-none sm:bottom-4 sm:right-4",
        className
      )}
      {...props}
    />
  );
}

export type ToastVariant = "default" | "success" | "warning" | "danger";

const ICONS: Record<ToastVariant, React.ComponentType<{ className?: string }>> = {
  default: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  danger: XCircle,
};

const ICON_COLOR: Record<ToastVariant, string> = {
  default: "text-primary",
  success: "text-success",
  warning: "text-warning",
  danger: "text-danger",
};

export function Toast({
  className,
  variant = "default",
  title,
  description,
  ...props
}: React.ComponentPropsWithoutRef<typeof ToastPrimitive.Root> & {
  variant?: ToastVariant;
  title: string;
  description?: string;
}) {
  const Icon = ICONS[variant];
  return (
    <ToastPrimitive.Root
      className={cn(
        "panel-edge pointer-events-auto flex w-full items-start gap-3 rounded-lg border border-border bg-card p-4 shadow-xl shadow-black/30 data-[state=open]:animate-toast-in data-[state=closed]:animate-toast-out data-[swipe=end]:animate-toast-out",
        className
      )}
      {...props}
    >
      <Icon className={cn("mt-0.5 h-4.5 w-4.5 shrink-0", ICON_COLOR[variant])} />
      <div className="flex-1 space-y-0.5">
        <ToastPrimitive.Title className="text-sm font-medium">{title}</ToastPrimitive.Title>
        {description && <ToastPrimitive.Description className="text-sm text-muted-foreground">{description}</ToastPrimitive.Description>}
      </div>
      <ToastPrimitive.Close className="text-muted-foreground transition-colors hover:text-foreground">
        <X className="h-4 w-4" />
      </ToastPrimitive.Close>
    </ToastPrimitive.Root>
  );
}
