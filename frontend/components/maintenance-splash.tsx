import { Wrench } from "lucide-react";

export function MaintenanceSplash({ message }: { message: string | null }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-6 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-full bg-primary/10 text-primary">
        <Wrench className="h-6 w-6" />
      </div>
      <h1 className="mt-5 text-2xl font-semibold tracking-tight">TaskFlow is down for maintenance</h1>
      <p className="mt-2 max-w-md text-sm text-muted-foreground">
        {message ?? "We're making some changes behind the scenes. This shouldn't take long — check back shortly."}
      </p>
    </div>
  );
}
