import { Card, CardContent } from "@/components/ui/card";

export default function ComputePage() {
  return (
    <div>
      <h1 className="text-2xl font-semibold">Compute</h1>
      <Card className="mt-6">
        <CardContent className="pt-6">
          <p className="font-medium">Dedicated GPU rental isn't live yet.</p>
          <p className="mt-2 text-sm text-muted-foreground">
            This is a later build phase (see the TaskFlow architecture spec, Phase 8/9): GPU catalog, rental,
            lifecycle management, auto-shutdown, and deployments. It intentionally isn't wired up yet — we don't
            show fake GPU instances or pricing here. When it ships, you'll be able to rent a GPU, deploy a model,
            and get a managed API endpoint from this page.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
