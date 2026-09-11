import Link from "next/link";
import { Compass } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-6 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <Compass className="h-6 w-6" />
      </div>
      <p className="mt-5 font-mono-data text-sm text-muted-foreground">404</p>
      <h1 className="mt-1 text-2xl font-semibold tracking-tight">This page doesn't exist</h1>
      <p className="mt-2 max-w-sm text-sm text-muted-foreground">
        The link might be old, or the page may have moved. Check the URL, or head back to somewhere that does exist.
      </p>
      <div className="mt-6 flex gap-3">
        <Link href="/">
          <Button variant="secondary">Go to homepage</Button>
        </Link>
        <Link href="/dashboard">
          <Button>Go to dashboard</Button>
        </Link>
      </div>
    </div>
  );
}
