import Link from "next/link";
import { notFound } from "next/navigation";
import { requireHuman } from "@/lib/auth";
import { isInstanceAdmin } from "@/lib/auth-policy";
import { listTeams } from "@/lib/teams-admin";
import { timeAgo } from "@/lib/time";

export const dynamic = "force-dynamic";

export default async function AdminTeamsPage() {
  const { user, team } = await requireHuman();
  if (!isInstanceAdmin(user.email)) notFound(); // not an admin: the page does not exist
  const teams = await listTeams({ userId: user.id, email: user.email, teamId: team.id });
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl space-y-6 px-6 py-10">
        <div>
          <h1 className="text-xl font-semibold">Teams on this server</h1>
          <p className="mt-1 text-sm text-muted">
            Who is here, and a way to suspend a whole team. You see names, emails and counts only, never what a team wrote.
          </p>
        </div>
        <div className="card divide-y divide-line">
          {teams.map((t) => (
            <Link key={t.id} href={`/admin/teams/${t.id}`} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-sm hover:bg-panel-2">
              <div className="min-w-48 flex-1">
                <div className="font-medium">
                  {t.name}
                  {t.isYours && <span className="text-muted"> (yours)</span>}
                  {t.suspendedAt && <span className="chip ml-2 bg-danger/15 text-danger">suspended</span>}
                </div>
                <div className="text-xs text-muted">
                  {t.owners.map((o) => o.email).join(", ") || "no owner"}
                  {t.invitedBy && <> · invited by {t.invitedBy.email}</>}
                </div>
              </div>
              <div className="text-xs text-muted">{t.seatsUsed} of {t.maxSeats} seats ({t.members} members, {t.pendingInvites} pending)</div>
              <div className="text-xs text-muted">{t.projects} project{t.projects === 1 ? "" : "s"}</div>
              <div className="w-24 text-right text-xs text-muted">{t.lastActivity ? timeAgo(t.lastActivity) : "no activity"}</div>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
