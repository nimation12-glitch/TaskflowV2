import { auth } from "@/auth";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { getSshKeys } from "@/lib/ssh-keys-client";
import { getRentals } from "@/lib/compute-client";
import { SshKeysSection, AccountSection } from "./settings-client";
import { ROADMAP_ITEMS } from "@/lib/roadmap";

export default async function SettingsPage() {
  const session = await auth();
  const [keys, rentals] = await Promise.all([getSshKeys(), getRentals()]);

  const activeRentalKeyIds = rentals
    .filter((r) => r.status === "RUNNING" || r.status === "PROVISIONING" || r.status === "STOPPED")
    .map((r) => r.ssh_key_id);

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="mt-1.5 text-sm text-muted-foreground">SSH keys, account, and what's coming next.</p>
      </div>

      <SshKeysSection keys={keys} activeRentalKeyIds={activeRentalKeyIds} />
      <AccountSection email={session?.user?.email ?? "—"} />

      <Card>
        <CardHeader>
          <CardTitle className="text-foreground">Roadmap</CardTitle>
          <CardDescription>What we're building next.</CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="divide-y divide-border">
            {ROADMAP_ITEMS.map((item) => (
              <li key={item.title} className="py-3 first:pt-0 last:pb-0">
                <p className="text-sm font-medium">{item.title}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">{item.description}</p>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
