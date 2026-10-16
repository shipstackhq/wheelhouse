import Link from "next/link";
import { notFound } from "next/navigation";
import { requireHuman } from "@/lib/auth";
import { isInstanceAdmin } from "@wheelhouse/core/lib/auth-policy";
import { AdminError, getTeamDetail } from "@wheelhouse/core/lib/teams-admin";
import { restoreTeamAction } from "@/app/actions";
import { SuspendTeamForm } from "@/components/suspend-team-form";
import { timeAgo } from "@wheelhouse/core/lib/time";
import { SubmitButton } from "@/components/submit-button";

export const dynamic = "force-dynamic";

const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : "never");

export default async function AdminTeamPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, team } = await requireHuman();
  if (!isInstanceAdmin(user.email)) notFound();
  let t;
  try {
    t = await getTeamDetail({ userId: user.id, email: user.email, teamId: team.id }, id);
  } catch (e) {
    if (e instanceof AdminError) notFound();
    throw e;
  }
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl space-y-6 px-6 py-10">
        <div>
          <Link href="/admin/teams" className="text-sm text-muted hover:text-fg">← All teams</Link>
          <h1 className="mt-2 text-xl font-semibold">
            {t.name}
            {t.suspendedAt && <span className="chip ml-3 bg-danger/15 align-middle text-danger">suspended</span>}
          </h1>
          <p className="mt-1 text-sm text-muted">
            Created {day(t.createdAt)} · {t.projects} project{t.projects === 1 ? "" : "s"} · last activity {t.lastActivity ? timeAgo(t.lastActivity) : "none"}
            {t.invitedBy && <> · invited by {t.invitedBy.email}</>}
          </p>
        </div>

        <div className="card divide-y divide-line">
          <div className="px-4 py-2 text-xs font-medium text-muted">Members ({t.memberList.length})</div>
          {t.memberList.map((m) => (
            <div key={m.userId} className="flex flex-wrap items-center gap-3 px-4 py-2 text-sm">
              <div className="min-w-48 flex-1">
                <div className="font-medium">{m.name}</div>
                <div className="text-xs text-muted">{m.email}</div>
              </div>
              <span className="chip bg-panel-2 text-fg">{m.role}</span>
              <span className="text-xs text-muted">joined {day(m.joinedAt)}</span>
            </div>
          ))}
        </div>

        <div className="card divide-y divide-line">
          <div className="px-4 py-2 text-xs font-medium text-muted">Invites</div>
          {t.inviteList.length === 0 && <p className="px-4 py-3 text-sm text-muted">No invites.</p>}
          {t.inviteList.map((i) => (
            <div key={i.id} className="flex flex-wrap items-center gap-3 px-4 py-2 text-sm">
              <div className="min-w-48 flex-1">{i.email}</div>
              <span className="text-xs text-muted">{i.kind === "new_team" ? "started this team" : i.role}</span>
              <span className="chip bg-panel-2 text-fg">{i.status}</span>
              <span className="text-xs text-muted">{day(i.createdAt)}</span>
            </div>
          ))}
        </div>

        <div className="card divide-y divide-line">
          <div className="px-4 py-2 text-xs font-medium text-muted">API keys</div>
          {t.keys.length === 0 && <p className="px-4 py-3 text-sm text-muted">No keys.</p>}
          {t.keys.map((k) => (
            <div key={k.id} className="flex flex-wrap items-center gap-3 px-4 py-2 text-sm">
              <div className="min-w-48 flex-1">
                <span className="font-medium">{k.name}</span> <code className="font-mono text-xs text-muted">{k.prefix}…</code>
              </div>
              <span className="text-xs text-muted">{k.revokedAt ? `revoked ${day(k.revokedAt)}` : `last used ${k.lastUsedAt ? timeAgo(k.lastUsedAt) : "never"}`}</span>
            </div>
          ))}
        </div>

        <p className="text-xs text-muted">Tickets, comments and the map of this team are not shown here.</p>

        {t.suspendedAt ? (
          <div className="card border-danger/40 p-5">
            <h2 className="font-medium">Suspended {day(t.suspendedAt)}{t.suspendedBy && <> by {t.suspendedBy.email}</>}</h2>
            {t.suspendedReason && <p className="mt-1 text-sm text-muted">Reason: {t.suspendedReason}</p>}
            <p className="mt-2 text-sm text-muted">
              Members cannot sign in and the team&apos;s API keys are refused. Restoring brings everything back; people sign in again.
            </p>
            <form action={restoreTeamAction} className="mt-4">
              <input type="hidden" name="teamId" value={t.id} />
              <SubmitButton className="btn btn-primary">Restore team</SubmitButton>
            </form>
          </div>
        ) : t.isYours ? (
          <div className="card p-5 text-sm text-muted">This is your own team, so it cannot be suspended.</div>
        ) : (
          <div className="card border-danger/40 p-5">
            <h2 className="font-medium text-danger">Suspend this team</h2>
            <SuspendTeamForm teamId={t.id} teamName={t.name} members={t.members} />
          </div>
        )}
      </div>
    </div>
  );
}
