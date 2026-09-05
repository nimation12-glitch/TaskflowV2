import { backendJson } from "@/lib/backend-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { inviteMemberAction, removeMemberAction } from "./actions";

type Member = { user_id: string; role: string; joined_at: string };
type Invitation = { id: string; invited_email: string; role: string; expires_at: string };
type OrgSummary = { plan: { max_members: number } | null; role: string };

export default async function TeamPage() {
  const [members, invitations, org] = await Promise.all([
    backendJson<Member[]>("/team/members"),
    backendJson<Invitation[]>("/team/invitations"),
    backendJson<OrgSummary>("/organizations/me"),
  ]);

  const seatCount = members.length + invitations.length;
  const maxSeats = org.plan?.max_members ?? 3;
  const canManage = org.role === "OWNER" || org.role === "ADMIN";

  return (
    <div className="max-w-2xl">
      <h1 className="text-2xl font-semibold">Team</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        {seatCount}/{maxSeats} members
      </p>

      {canManage && (
        <form
          action={async (formData: FormData) => {
            "use server";
            const email = formData.get("email") as string;
            await inviteMemberAction(email, "MEMBER");
          }}
          className="mt-6 flex gap-2"
        >
          <Input name="email" type="email" placeholder="teammate@company.com" required className="flex-1" />
          <Button type="submit" disabled={seatCount >= maxSeats}>
            Invite
          </Button>
        </form>
      )}
      {seatCount >= maxSeats && (
        <p className="mt-2 text-sm text-amber-400">
          You've reached your plan's member limit. Upgrade to invite more people.
        </p>
      )}

      <h2 className="mt-8 text-sm font-medium text-muted-foreground">Members</h2>
      <div className="mt-3 divide-y divide-border rounded-lg border border-border">
        {members.map((m) => (
          <div key={m.user_id} className="flex items-center justify-between p-4">
            <div>
              <p className="font-mono-data text-sm">{m.user_id}</p>
              <p className="text-xs text-muted-foreground">{m.role}</p>
            </div>
            {canManage && m.role !== "OWNER" && (
              <form
                action={async () => {
                  "use server";
                  await removeMemberAction(m.user_id);
                }}
              >
                <Button variant="danger" type="submit">
                  Remove
                </Button>
              </form>
            )}
          </div>
        ))}
      </div>

      {invitations.length > 0 && (
        <>
          <h2 className="mt-8 text-sm font-medium text-muted-foreground">Pending invitations</h2>
          <div className="mt-3 divide-y divide-border rounded-lg border border-border">
            {invitations.map((i) => (
              <div key={i.id} className="p-4 text-sm">
                {i.invited_email} — {i.role} — expires {new Date(i.expires_at).toLocaleDateString()}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
