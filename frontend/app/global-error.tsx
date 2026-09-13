"use client";

// Next.js only lets a global-error.tsx catch errors thrown in the root
// layout itself (app/layout.tsx) — the regular app/(app)/error.tsx boundary
// sits BELOW the root layout and can't see those. This is the reason a
// throw in getThemePreference/isPlatformAdmin produced Next's raw unstyled
// crash page instead of anything in this app's own design: there was no
// file here to catch it. Both of those lookups now fail safe on their own
// (see lib/theme.ts, lib/platform-admin.ts) — this is the last-resort net
// for anything else that might throw at this level in the future.
//
// Because this replaces the entire <html>/<body> (the root layout that
// would normally render them may itself be the thing that failed), it
// can't rely on providers or context from that layout — it renders a
// fully self-contained page, importing global styles directly.
import "./globals.css";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body className="font-sans antialiased">
        <div className="flex min-h-screen items-center justify-center px-6">
          <div className="w-full max-w-md rounded-lg border border-border bg-gradient-to-b from-card to-card/80 text-card-foreground shadow-lg shadow-black/20 p-6 text-center">
            <p className="font-medium">Something went wrong.</p>
            <p className="mt-2 text-sm text-muted-foreground">
              We've been notified and are looking into it. This is usually temporary — try again in a moment.
            </p>
            <div className="mt-6">
              <button
                onClick={() => reset()}
                className="h-10 w-full rounded-md bg-primary px-4 text-sm text-primary-foreground shadow-md shadow-primary/25 hover:shadow-lg hover:shadow-primary/30 hover:brightness-110 active:brightness-95"
              >
                Try again
              </button>
            </div>
            {error.digest && <p className="mt-4 text-xs text-muted-foreground">Reference: {error.digest}</p>}
          </div>
        </div>
      </body>
    </html>
  );
}