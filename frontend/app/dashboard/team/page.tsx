import { backendJson } from "@/lib/backend-client";
import { TeamClient } from "./team-client";

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
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">Team</h1>
      <p className="mt-1.5 text-sm text-muted-foreground">
        {seatCount}/{maxSeats} seats used
      </p>
      <TeamClient members={members} invitations={invitations} canManage={canManage} seatCount={seatCount} maxSeats={maxSeats} />
    </div>
  );
}
