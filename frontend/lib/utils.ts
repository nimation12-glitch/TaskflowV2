import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Formats integer micro-GBP (1,000,000 micros = £1) as a GBP string. */
export function formatGbp(micros: number, opts?: { precise?: boolean }): string {
  const amount = micros / 1_000_000;
  return `£${amount.toLocaleString("en-GB", {
    minimumFractionDigits: opts?.precise ? 4 : 2,
    maximumFractionDigits: opts?.precise ? 4 : 2,
  })}`;
}

export function formatNumber(n: number): string {
  return n.toLocaleString("en-GB");
}

export function formatDate(iso: string, opts?: Intl.DateTimeFormatOptions): string {
  return new Date(iso).toLocaleDateString("en-GB", opts ?? { day: "numeric", month: "short", year: "numeric" });
}

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function initials(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return "?";
  const parts = trimmed.split(/[\s@._-]+/).filter(Boolean);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}
