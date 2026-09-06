"use client";

import * as React from "react";
import type { ToastVariant } from "./toast";

type ToastRecord = {
  id: string;
  title: string;
  description?: string;
  variant: ToastVariant;
};

type Listener = (toasts: ToastRecord[]) => void;

let toasts: ToastRecord[] = [];
const listeners = new Set<Listener>();

function emit() {
  listeners.forEach((listener) => listener(toasts));
}

function dismiss(id: string) {
  toasts = toasts.filter((t) => t.id !== id);
  emit();
}

export function toast(input: { title: string; description?: string; variant?: ToastVariant; durationMs?: number }) {
  const id = Math.random().toString(36).slice(2);
  toasts = [...toasts, { id, title: input.title, description: input.description, variant: input.variant ?? "default" }];
  emit();
  const duration = input.durationMs ?? 4500;
  setTimeout(() => dismiss(id), duration);
  return id;
}

export function useToasts() {
  const [state, setState] = React.useState<ToastRecord[]>(toasts);
  React.useEffect(() => {
    listeners.add(setState);
    return () => {
      listeners.delete(setState);
    };
  }, []);
  return { toasts: state, dismiss };
}
