"use client";

import { Toast, ToastProvider, ToastViewport } from "./toast";
import { useToasts } from "./use-toast";

export function Toaster() {
  const { toasts, dismiss } = useToasts();
  return (
    <ToastProvider swipeDirection="right">
      {toasts.map((t) => (
        <Toast
          key={t.id}
          title={t.title}
          description={t.description}
          variant={t.variant}
          onOpenChange={(open) => {
            if (!open) dismiss(t.id);
          }}
        />
      ))}
      <ToastViewport />
    </ToastProvider>
  );
}
