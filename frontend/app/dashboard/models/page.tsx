import { backendJson } from "@/lib/backend-client";

type ModelRow = {
  slug: string;
  display_name: string;
  provider: string | null;
  hosting_mode: string;
  status: string;
  context_window: number | null;
  entitled_plans: string[];
  accessible_on_current_plan: boolean;
};

const STATUS_LABEL: Record<string, string> = {
  LIVE: "Live",
  COMING_SOON: "Coming soon",
  DISABLED: "Disabled",
  NOT_CONFIGURED: "Not configured",
  DEMO_ONLY: "Demo only",
};

export default async function ModelsPage() {
  const models = await backendJson<ModelRow[]>("/models");

  return (
    <div>
      <h1 className="text-2xl font-semibold">Models</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Availability is enforced server-side by your plan — this list always reflects what you can actually call.
      </p>

      <div className="mt-6 overflow-hidden rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
            <tr>
              <th className="p-3">Model</th>
              <th className="p-3">Provider</th>
              <th className="p-3">Context</th>
              <th className="p-3">Status</th>
              <th className="p-3">Requires</th>
              <th className="p-3">Access</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {models.map((m) => (
              <tr key={m.slug}>
                <td className="p-3 font-medium">{m.display_name}</td>
                <td className="p-3 text-muted-foreground">{m.provider ?? "—"}</td>
                <td className="p-3 text-muted-foreground">{m.context_window?.toLocaleString() ?? "—"}</td>
                <td className="p-3 text-muted-foreground">{STATUS_LABEL[m.status] ?? m.status}</td>
                <td className="p-3 text-muted-foreground">{m.entitled_plans.join(", ")}</td>
                <td className="p-3">
                  {m.accessible_on_current_plan ? (
                    <span className="text-emerald-400">Available</span>
                  ) : (
                    <span className="text-muted-foreground">Upgrade required</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
