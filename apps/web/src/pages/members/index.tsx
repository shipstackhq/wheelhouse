import { useState } from "react";
import { useParams } from "react-router";
import { Dialog } from "radix-ui";
import { useQuery } from "@tanstack/react-query";
import type { TeamMember, TeamRole } from "@wheelhouse/api-client";
import { Loaded } from "../../components/query-state";
import { Select, useDialogs } from "../../components/ui";
import { failure } from "../../lib/form-state";
import { addableMembersQuery, useTeamMembers } from "../../lib/queries";
import { refreshAll } from "../../lib/refresh";
import { TEAM_ROLES } from "../../lib/roles";
import { useServices } from "../../lib/services";
import { useMe } from "../../lib/session";

/**
 * `/t/:key/members`: who can open this team and with what role (ADR-23). A team is reachable only through this list;
 * the workspace role never opens it. Any member reads it; team admins add, re-role and remove people.
 */
export function TeamMembersPage() {
  const { key = "" } = useParams();
  const query = useTeamMembers(key);
  return (
    <Loaded query={query} label="Loading the members">
      {(d) => <Members teamKey={key} teamName={d.team.name} myRole={d.myRole} members={d.members} />}
    </Loaded>
  );
}

const initial = (name: string) => (name[0] ?? "?").toUpperCase();

function Members({ teamKey, teamName, myRole, members }: { teamKey: string; teamName: string; myRole: TeamRole | null; members: TeamMember[] }) {
  const { api, queryClient } = useServices();
  const youId = useMe().data?.user.id;
  const isAdmin = myRole === "admin";
  const { confirm, dialogs } = useDialogs();
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string>();
  const attempt = async (run: () => Promise<unknown>) => {
    setError(undefined);
    try {
      await run();
    } catch (e) {
      setError(failure(e)?.error);
    }
    await refreshAll(queryClient);
  };
  const admins = members.filter((m) => m.role === "admin").length;

  return (
    <div className="h-full overflow-y-auto bg-page">
      <div className="w-full px-4 py-8 sm:px-8 lg:py-12">
        <div className="mb-2 flex items-center justify-end gap-3">
          <h1 className="sr-only">Team members</h1>
          {isAdmin && (
            <button className="btn btn-primary shrink-0" onClick={() => setAdding(true)}>
              + Add member
            </button>
          )}
        </div>
        <p className="mb-6 text-sm text-muted">
          Only the people listed here can open <span className="font-medium text-fg">{teamName}</span>. Your role: <span className="font-medium text-fg">{myRole ?? "none"}</span>.
          {!isAdmin && " Ask a team admin to add someone or change a role."}
        </p>
        {error && <p role="alert" className="mb-4 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>}

        <ul className="card divide-y divide-line">
          {members.map((m) => {
            const isYou = m.userId === youId;
            const lastAdmin = m.role === "admin" && admins <= 1;
            return (
              <li key={m.userId} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent/15 text-sm font-semibold text-accent" aria-hidden>
                  {initial(m.name)}
                </span>
                <div className="min-w-40 flex-1">
                  <div className="font-medium">{m.name}{isYou && <span className="text-muted"> (you)</span>}</div>
                  <div className="text-xs text-muted">{m.email} · workspace {m.workspaceRole}</div>
                </div>
                {isAdmin ? (
                  <Select
                    value={m.role}
                    ariaLabel={`Role of ${m.name}`}
                    className="w-28"
                    options={TEAM_ROLES.map((r) => ({ value: r.value, label: r.label }))}
                    onValueChange={(v) => attempt(() => api.teams.setMemberRole(teamKey, m.userId, v as TeamRole))}
                  />
                ) : (
                  <span className="chip bg-panel-2 text-fg">{m.role}</span>
                )}
                {(isAdmin || isYou) && (
                  <button
                    className="btn btn-danger"
                    disabled={lastAdmin}
                    title={lastAdmin ? "A team needs at least one admin" : undefined}
                    onClick={async () => {
                      const ok = await confirm({
                        title: isYou ? `Leave ${teamName}?` : `Remove ${m.name}?`,
                        description: isYou ? "You will no longer be able to open this team until someone adds you again." : `${m.name} will no longer be able to open ${teamName}.`,
                        confirmLabel: isYou ? "Leave" : "Remove",
                        danger: true,
                      });
                      if (ok) await attempt(() => api.teams.removeMember(teamKey, m.userId));
                    }}
                  >
                    {isYou ? "Leave" : "Remove"}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      </div>
      {adding && <AddMemberDialog teamKey={teamKey} onClose={() => setAdding(false)} />}
      {dialogs}
    </div>
  );
}

function AddMemberDialog({ teamKey, onClose }: { teamKey: string; onClose: () => void }) {
  const { api, queryClient } = useServices();
  const query = useQuery(addableMembersQuery(api, teamKey));
  const [role, setRole] = useState<TeamRole>("editor");
  const [error, setError] = useState<string>();
  const people = query.data ?? [];
  const add = async (userId: string) => {
    setError(undefined);
    try {
      await api.teams.addMember(teamKey, { userId, role });
    } catch (e) {
      setError(failure(e)?.error);
      return;
    }
    await refreshAll(queryClient);
  };
  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/50" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[80vh] w-[min(94vw,520px)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-lg border border-line bg-panel text-fg shadow-2xl">
          <div className="border-b border-line px-5 py-3">
            <Dialog.Title className="font-semibold">Add to the team</Dialog.Title>
            <Dialog.Description className="text-xs text-muted">People already in the workspace. They get the role below.</Dialog.Description>
          </div>
          <div className="flex items-center gap-2 border-b border-line px-5 py-3 text-sm">
            <span className="text-muted">Role</span>
            <Select value={role} ariaLabel="Role to give" className="w-32" options={TEAM_ROLES.map((r) => ({ value: r.value, label: r.label }))} onValueChange={(v) => setRole(v as TeamRole)} />
            <span className="text-xs text-muted">{TEAM_ROLES.find((r) => r.value === role)?.hint}</span>
          </div>
          <ul className="flex-1 divide-y divide-line overflow-y-auto px-2">
            {query.isPending && <li className="px-3 py-4 text-sm text-muted">Loading…</li>}
            {query.isSuccess && people.length === 0 && <li className="px-3 py-4 text-sm text-muted">Everyone in the workspace is already in this team. Invite people from the Members page in the sidebar first.</li>}
            {people.map((p) => (
              <li key={p.userId} className="flex items-center gap-3 px-3 py-2.5 text-sm">
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{p.name}</div>
                  <div className="truncate text-xs text-muted">{p.email} · workspace {p.workspaceRole}</div>
                </div>
                <button className="btn" onClick={() => add(p.userId)} aria-label={`Add ${p.name}`}>Add</button>
              </li>
            ))}
          </ul>
          {error && <p className="border-t border-line px-5 py-2 text-sm text-danger" role="alert">{error}</p>}
          <div className="flex justify-end border-t border-line p-3">
            <Dialog.Close className="btn">Done</Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
