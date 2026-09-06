import Link from "next/link";
import { Sparkles, Cpu } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function ModelsPage() {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-full bg-primary/10 text-primary">
        <Sparkles className="h-6 w-6" />
      </div>
      <h1 className="mt-5 text-2xl font-semibold tracking-tight">The AI Model Gateway is paused</h1>
      <p className="mt-2 max-w-md text-sm text-muted-foreground">
        Pay-per-token access to hosted models — plus API keys and usage analytics — is coming back soon. For now,
        rent a dedicated GPU and run whatever you need on it directly.
      </p>
      <Link href="/dashboard/compute" className="mt-6">
        <Button>
          <Cpu className="h-4 w-4" />
          Rent a GPU
        </Button>
      </Link>
    </div>
  );
}
