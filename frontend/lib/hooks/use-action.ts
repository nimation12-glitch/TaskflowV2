"use client";

import { useTransition } from "react";
import { toast } from "@/components/ui/use-toast";

/**
 * Wraps a server action call with a pending flag and toast feedback.
 * Server actions that redirect() will throw NEXT_REDIRECT internally — Next.js
 * handles that specially, so we let it propagate rather than treating it as an error.
 */
export function useAction() {
  const [pending, startTransition] = useTransition();

  function run<T>(
    fn: () => Promise<T>,
    opts?: { success?: string; error?: string; onSuccess?: (result: T) => void }
  ) {
    startTransition(async () => {
      try {
        const result = await fn();
        if (opts?.success) toast({ title: opts.success, variant: "success" });
        opts?.onSuccess?.(result);
      } catch (err) {
        if (err instanceof Error && err.message === "NEXT_REDIRECT") throw err;
        if (typeof err === "object" && err !== null && "digest" in err && String((err as any).digest).startsWith("NEXT_REDIRECT")) {
          throw err;
        }
        toast({
          title: opts?.error ?? "Something went wrong",
          description: err instanceof Error ? err.message : undefined,
          variant: "danger",
        });
      }
    });
  }

  return { pending, run };
}
