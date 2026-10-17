import { Link, useParams } from "react-router";
import { timeAgo } from "@wheelhouse/core/lib/time";
import { InviteForm } from "../components/invite-form";
import { PendingInvites } from "../components/pending-invites";
import { Loaded } from "../components/query-state";
import { SubmitButton } from "../components/submit-button";
import { SuspendTeamForm } from "../components/suspend-team-form";
import { useAdminTeam, useAdminTeams, useInvites } from "../lib/queries";
import { refreshAll } from "../lib/refresh";
import { useServices } from "../lib/services";
import { ArrowLeftIcon } from "../components/icons";

const day = (d: string | null) => (d ? d.slice(0, 10) : "never");

/** Every team on this server. Names, emails and counts only: never what a team wrote. */
export function AdminTeamsPage() {
  const query = useAdminTeams();
  return (
    <Loaded query={query} label="Loading teams">
      {(teams) => (
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
                <Link key={t.id} to={`/admin/teams/${t.id}`} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-sm hover:bg-panel-2">
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
      )}
    </Loaded>
  );
}

export function AdminTeamPage() {
  const { id = "" } = useParams();
  const { api, queryClient } = useServices();
  const query = useAdminTeam(id);
  return (
    <Loaded query={query} label="Loading the team">
      {(t) => (
        <div className="h-full overflow-y-auto">
          <div className="mx-auto max-w-3xl space-y-6 px-6 py-10">
            <div>
              <Link to="/admin/teams" className="text-sm text-muted hover:text-fg"><ArrowLeftIcon /> All teams</Link>
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
                <form
                  action={async () => {
                    try {
                      await api.admin.restore(t.id);
                    } finally {
                      await refreshAll(queryClient);
                    }
                  }}
                  className="mt-4"
                >
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
      )}
    </Loaded>
  );
}

/** Invite someone to start a team of their own (instance admins only). */
export function AdminInvitesPage() {
  const query = useInvites("new_team");
  return (
    <Loaded query={query} label="Loading invites">
      {(pending) => (
        <div className="h-full overflow-y-auto">
          <div className="mx-auto max-w-3xl space-y-8 px-6 py-10">
            <div>
              <h1 className="text-xl font-semibold">Invite a new team</h1>
              <p className="mt-1 text-sm text-muted">
                For people outside your team. They follow the link, choose a password and get their own team, which they own.
              </p>
            </div>
            <div className="card p-5">
              <InviteForm kind="new_team" />
              <h3 className="mt-6 text-sm font-medium">Pending invites</h3>
              <PendingInvites invites={pending} />
            </div>
          </div>
        </div>
      )}
    </Loaded>
  );
}
