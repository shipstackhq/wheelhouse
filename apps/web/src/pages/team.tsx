import { useActionState, useState } from "react";
import type { Role, TeamMember } from "@wheelhouse/api-client";
import { InviteForm } from "../components/invite-form";
import { AccessLog, ProjectsAccess } from "../components/workspace-access";
import { PendingInvites } from "../components/pending-invites";
import { Loaded } from "../components/query-state";
import { SubmitButton } from "../components/submit-button";
import { Select } from "../components/ui";
import { failure, field, type FormState } from "../lib/form-state";
import { useTeam } from "../lib/queries";
import { asRole, assignableRoles, canManagePeople } from "../lib/roles";
import { useMe, useProjects } from "../lib/session";
import { refreshAll } from "../lib/refresh";
import { useServices } from "../lib/services";

export function TeamPage() {
  const query = useTeam();
  const adminOf = (useProjects().data ?? []).filter((p) => p.role === "admin");
  const youId = useMe().data?.user.id;
  return (
    <Loaded query={query} label="Loading the workspace">
      {(t) => {
        const canManage = canManagePeople(t.role);
        return (
          <div className="h-full overflow-y-auto">
            <div className="mx-auto max-w-3xl space-y-8 px-6 py-10">
              <div>
                <h1 className="text-xl font-semibold">{t.team.name}</h1>
                <p className="mt-1 text-sm text-muted">Members, roles and tags. A role decides what someone can do around projects; they reach a project only when they are added to it. Tags are free-form (e.g. backend, design, pm).</p>
              </div>

              <div className="card divide-y divide-line">
                {t.members.map((m) => (
                  <MemberRow key={m.userId} member={m} mine={t.role} isYou={m.userId === youId} />
                ))}
              </div>

              {canManage && (
                <div className="card p-5">
                  <div className="flex items-baseline justify-between gap-3">
                    <h2 className="font-medium">Invite someone</h2>
                    <span className="text-xs text-muted">
                      {t.seats.used} of {t.seats.max} seats used ({t.seats.members} members, {t.seats.pending} pending)
                    </span>
                  </div>
                  <p className="mt-1 text-sm text-muted">
                    Creates a one-time link for one person. It works until it is used, revoked or expires, and is shown only once.
                  </p>
                  {t.seats.full && (
                    <p className="mt-2 text-sm text-warn">Your workspace is full. Revoke a pending invite or remove a member to free a seat.</p>
                  )}
                  <InviteForm kind="join_team" disabled={t.seats.full} roles={assignableRoles(t.role)} projects={adminOf} />
                  <h3 className="mt-6 text-sm font-medium">Pending invites</h3>
                  <PendingInvites invites={t.pendingInvites} />
                </div>
              )}

              {canManage && <ProjectsAccess />}
              {canManage && <AccessLog />}

              <div className="card p-5">
                <h2 className="font-medium">Your password</h2>
                <ChangePasswordForm />
              </div>
            </div>
          </div>
        );
      }}
    </Loaded>
  );
}

/** One member: owners and admins edit role and tags or remove them (an admin leaves owners alone); everyone else just reads. */
function MemberRow({ member: m, mine, isYou }: { member: TeamMember; mine: Role; isYou: boolean }) {
  const canEdit = canManagePeople(mine) && (mine === "owner" || m.role !== "owner");
  const { api, queryClient } = useServices();
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
  return (
    <form
      action={(fd) => attempt(() => api.team.updateMember(m.userId, { role: asRole(field(fd, "role")), tags: field(fd, "tags") }))}
      className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm"
    >
      <div className="min-w-40 flex-1">
        <div className="font-medium">{m.name}{isYou && <span className="text-muted"> (you)</span>}</div>
        <div className="text-xs text-muted">{m.email}</div>
      </div>
      {canEdit ? (
        <>
          <Select name="role" defaultValue={m.role} className="w-28" options={assignableRoles(mine).map((r) => ({ value: r.value, label: r.label }))} />
          <input name="tags" defaultValue={m.tags.join(", ")} placeholder="tags" aria-label={`Tags for ${m.name}`} className="input w-48 py-1.5" />
          <SubmitButton className="btn">Save</SubmitButton>
          {!isYou && (
            <SubmitButton formAction={() => attempt(() => api.team.removeMember(m.userId))} className="btn btn-danger">Remove</SubmitButton>
          )}
          {error && <p className="basis-full text-sm text-danger" role="alert">{error}</p>}
        </>
      ) : (
        <div className="flex gap-1">
          <span className="chip bg-panel-2 text-fg">{m.role satisfies Role}</span>
          {m.tags.map((t) => <span key={t} className="chip bg-bg text-muted">{t}</span>)}
        </div>
      )}
    </form>
  );
}

function ChangePasswordForm() {
  const { api } = useServices();
  const [state, action] = useActionState<FormState, FormData>(async (_prev, fd) => {
    try {
      await api.changePassword({ current: field(fd, "current"), next: field(fd, "next") });
      return { ok: "Password updated" };
    } catch (e) {
      return failure(e);
    }
  }, undefined);
  return (
    <form action={action} className="mt-4 grid gap-3 sm:grid-cols-[1fr_1fr_auto]">
      <input className="input" name="current" type="password" placeholder="Current password" aria-label="Current password" required autoComplete="current-password" />
      <input className="input" name="next" type="password" placeholder="New password (12+)" aria-label="New password" required minLength={12} autoComplete="new-password" />
      <SubmitButton className="btn">Update</SubmitButton>
      {state?.error && <p className="text-sm text-danger sm:col-span-3" role="alert">{state.error}</p>}
      {state?.ok && <p className="text-sm text-ok sm:col-span-3" role="status">{state.ok}</p>}
    </form>
  );
}
