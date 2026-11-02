import { useState } from "react";
import { Dialog } from "radix-ui";
import type { Role, Seats, WorkspaceMember } from "@wheelhouse/api-client";
import { CloseIcon } from "../components/icons";
import { InviteForm } from "../components/invite-form";
import { AccessLog, TeamsAccess } from "../components/workspace-access";
import { PendingInvites } from "../components/pending-invites";
import { SETTINGS_ROW_PAD, SettingsList, SettingsRow } from "../components/settings-list";
import { Loaded } from "../components/query-state";
import { SubmitButton } from "../components/submit-button";
import { Select } from "../components/ui";
import { failure, field } from "../lib/form-state";
import { useWorkspace } from "../lib/queries";
import { asRole, assignableRoles, canManagePeople } from "../lib/roles";
import { useMe, useTeams } from "../lib/session";
import { refreshAll } from "../lib/refresh";
import { useServices } from "../lib/services";
import { SettingsPage } from "../components/settings-page";

export function WorkspacePage() {
  const query = useWorkspace();
  const adminOf = (useTeams().data ?? []).filter((p) => p.role === "admin");
  const youId = useMe().data?.user.id;
  return (
    <Loaded query={query} label="Loading the workspace">
      {(t) => {
        const canManage = canManagePeople(t.role);
        return (
          <SettingsPage
            title={t.workspace.name}
            hint="Members, roles and tags. A role decides what someone can do around teams; they reach a team only when they are added to it. Tags are free-form (e.g. backend, design, pm)."
            action={canManage && <InviteDialog seats={t.seats} roles={assignableRoles(t.role)} teams={adminOf} />}
          >
              <SettingsList title="Members">
                {t.members.map((m) => (
                  <MemberRow key={m.userId} member={m} mine={t.role} isYou={m.userId === youId} />
                ))}
              </SettingsList>

              {canManage && (
                <SettingsList title="Pending invites">
                  <PendingInvites bare invites={t.pendingInvites} />
                </SettingsList>
              )}

              {canManage && <TeamsAccess />}
              {canManage && <AccessLog />}
          </SettingsPage>
        );
      }}
    </Loaded>
  );
}

/** The invitation: a button at the top of the page that opens the form, with the seats and a warning when the workspace is full. */
function InviteDialog({ seats, roles, teams }: { seats: Seats; roles: { value: Role; label: string }[]; teams: { key: string; name: string }[] }) {
  return (
    <Dialog.Root>
      <Dialog.Trigger className="btn btn-primary shrink-0">Invite someone</Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/50" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[90dvh] w-[min(94vw,480px)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border border-line bg-panel p-5 text-fg shadow-2xl">
          <Dialog.Title className="font-semibold">Invite someone</Dialog.Title>
          <Dialog.Close aria-label="Close" className="absolute right-3 top-3 rounded p-1 text-muted outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-accent/50">
            <CloseIcon aria-hidden />
          </Dialog.Close>
          <Dialog.Description className="mt-1 text-sm text-muted">
            Creates a one-time link for one person. It works until it is used, revoked or expires, and is shown only once.
          </Dialog.Description>
          <p className="mt-1 text-xs text-muted">
            {seats.used} of {seats.max} seats used ({seats.members} members, {seats.pending} pending)
          </p>
          {seats.full && <p className="mt-2 text-sm text-warn">Your workspace is full. Revoke a pending invite or remove a member to free a seat.</p>}
          <InviteForm kind="join_workspace" className="mt-4" disabled={seats.full} roles={roles} teams={teams} />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** One member: owners and admins edit role and tags or remove them (an admin leaves owners alone); everyone else just reads. */
function MemberRow({ member: m, mine, isYou }: { member: WorkspaceMember; mine: Role; isYou: boolean }) {
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
      action={(fd) => attempt(() => api.workspace.updateMember(m.userId, { role: asRole(field(fd, "role")), tags: field(fd, "tags") }))}
      className={`flex flex-wrap items-center gap-3 text-sm ${SETTINGS_ROW_PAD}`}
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
            <SubmitButton formAction={() => attempt(() => api.workspace.removeMember(m.userId))} className="btn btn-danger">Remove</SubmitButton>
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
