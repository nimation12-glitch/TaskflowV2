import { backendJson } from "@/lib/backend-client";
import { TeamClient } from "./team-client";
import { UnavailableNotice } from "@/components/ui/unavailable-notice";
import { safe } from "@/lib/safe-fetch";

type Member = { user_id: string; role: string; joined_at: string };
type Invitation = { id: string; invited_email: string; role: string; expires_at: string };
type OrgSummary = { plan: { max_members: number } | null; role: string };

export default async function TeamPage() {
  const [membersResult, invitationsResult, orgResult] = await Promise.all([
    safe(backendJson<Member[]>("/team/members"), []),
    safe(backendJson<Invitation[]>("/team/invitations"), []),
    // Default to MEMBER (least privilege) when we can't confirm the real role —
    // safer to briefly hide management controls than show them based on a guess.
    safe(backendJson<OrgSummary>("/organizations/me"), { plan: null, role: "MEMBER" }),
  ]);

  const members = membersResult.data;
  const invitations = invitationsResult.data;
  const org = orgResult.data;
  const anyUnavailable = !membersResult.ok || !invitationsResult.ok || !orgResult.ok;

  const seatCount = members.length + invitations.length;
  const maxSeats = org.plan?.max_members ?? 3;
  const canManage = org.role === "OWNER" || org.role === "ADMIN";

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">Team</h1>
      <p className="mt-1.5 text-sm text-muted-foreground">
        {seatCount}/{maxSeats} seats used
      </p>
      {anyUnavailable && (
        <div className="mt-4">
          <UnavailableNotice label="Some team data" />
        </div>
      )}
      <TeamClient members={members} invitations={invitations} canManage={canManage} seatCount={seatCount} maxSeats={maxSeats} />
    </div>
  );
}
