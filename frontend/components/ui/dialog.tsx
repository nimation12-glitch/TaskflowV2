"use client";

import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

export function DialogContent({ className, children, ...props }: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm animate-fade-in" />
      {/* The box itself never grows past the viewport: it is capped at
          100dvh - 2rem and only the INNER region scrolls, so tall dialogs
          (the workspace wizard's GPU step) can't push the close button off
          screen or cover the overlay. The ✕ sits outside the scroll area,
          so it stays reachable no matter how far the content has scrolled. */}
      <DialogPrimitive.Content
        className={cn(
          "fixed left-1/2 top-1/2 z-50 flex max-h-[calc(100dvh-2rem)] w-full max-w-md -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-lg border border-border bg-card text-card-foreground shadow-2xl shadow-black/40 animate-scale-in",
          className
        )}
        {...props}
      >
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-6">{children}</div>
        <DialogPrimitive.Close className="absolute right-4 top-4 z-10 rounded-sm text-muted-foreground transition-colors hover:text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50">
          <X className="h-4 w-4" />
          <span className="sr-only">Close</span>
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export function DialogHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("space-y-1.5 pr-6", className)} {...props} />;
}

export function DialogTitle({ className, ...props }: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>) {
  return <DialogPrimitive.Title className={cn("text-lg font-semibold", className)} {...props} />;
}

export function DialogDescription({ className, ...props }: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>) {
  return <DialogPrimitive.Description className={cn("text-sm text-muted-foreground", className)} {...props} />;
}

export function DialogFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        // Sticky inside the dialog's scroll area: in a tall dialog the
        // actions stay pinned to the bottom instead of scrolling out of
        // reach. The negative margins cancel DialogContent's inner padding
        // so the footer spans the full box. In a short dialog nothing
        // scrolls, so it renders exactly like a normal footer.
        "sticky bottom-0 z-10 -mx-6 -mb-6 mt-6 flex justify-end gap-2 border-t border-border bg-card px-6 pb-6 pt-3",
        className
      )}
      {...props}
    />
  );
}
