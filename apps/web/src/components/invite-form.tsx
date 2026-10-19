import { useActionState } from "react";
import type { TeamRole, Role } from "@wheelhouse/api-client";
import { failure, field, type FormState } from "../lib/form-state";
import { asRole, TEAM_ROLES, WORKSPACE_ROLES } from "../lib/roles";
import { refreshAll } from "../lib/refresh";
import { useServices } from "../lib/services";
import { SecretBox } from "./secret-box";
import { SubmitButton } from "./submit-button";
import { Select } from "./ui";

/** Create an invite link. `kind` decides what the link does; the server decides who may create it. */
export function InviteForm({ kind, disabled = false, className = "mt-4", roles = WORKSPACE_ROLES.filter((r) => r.value === "member" || r.value === "owner"), teams = [] }: { kind: "join_workspace" | "new_workspace"; disabled?: boolean; /** The roles this person may hand out. */ roles?: { value: Role; label: string }[]; /** Teams the person administers, to put the invitee into on accepting. */ teams?: { key: string; name: string }[]; /** Spacing around the form (the default sits it below a heading). */ className?: string }) {
  const { api, queryClient } = useServices();
  const [state, action] = useActionState<FormState, FormData>(async (_prev, fd) => {
    try {
      const inv = await api.invites.create({
        kind,
        email: field(fd, "email"),
        role: asRole(field(fd, "role")),
        tags: field(fd, "tags"),
        workspace: field(fd, "workspace"),
        ...(kind === "join_workspace" && fd.getAll("team").length
          ? { teams: fd.getAll("team").map((k) => ({ team: String(k), role: (field(fd, "teamRole") || "editor") as TeamRole })) }
          : {}),
      });
      void refreshAll(queryClient);
      return {
        ok: `Invite created for ${inv.email}. Send them this link. It is shown only once, works for one person and expires on ${inv.expiresAt.slice(0, 10)}:`,
        secret: inv.link,
      };
    } catch (e) {
      return failure(e);
    }
  }, undefined);
  return (
    <form action={action} className={`grid gap-3 sm:grid-cols-2 ${className}`}>
      <input type="hidden" name="kind" value={kind} />
      <input className="input sm:col-span-2" name="email" type="email" placeholder="Their email" required disabled={disabled} />
      {kind === "join_workspace" ? (
        <>
          <Select name="role" defaultValue="member" options={roles.map((r) => ({ value: r.value, label: r.label }))} />
          <input className="input" name="tags" placeholder="tags: backend, design" disabled={disabled} />
        </>
      ) : (
        <input className="input sm:col-span-2" name="workspace" placeholder="Workspace name (optional)" maxLength={100} />
      )}
      {kind === "join_workspace" && teams.length > 0 && (
        <fieldset className="sm:col-span-2 rounded-md border border-line p-3">
          <legend className="px-1 text-xs text-muted">Also add them to these teams (optional)</legend>
          <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-sm">
            {teams.map((p) => (
              <label key={p.key} className="flex items-center gap-1.5">
                <input type="checkbox" name="team" value={p.key} disabled={disabled} /> {p.name} <span className="font-mono text-xs text-muted">{p.key}</span>
              </label>
            ))}
          </div>
          <div className="mt-2 flex items-center gap-2 text-sm">
            <span className="text-muted">Team role</span>
            <Select name="teamRole" defaultValue="editor" className="w-28" options={TEAM_ROLES.map((r) => ({ value: r.value, label: r.label }))} />
          </div>
        </fieldset>
      )}
      {state?.error && <p className="text-sm text-danger sm:col-span-2">{state.error}</p>}
      {state?.ok && (
        <div className="sm:col-span-2">
          <p className="text-sm text-ok">{state.ok}</p>
          {state.secret && <SecretBox value={state.secret} />}
        </div>
      )}
      <div className="sm:col-span-2">
        <SubmitButton className="btn btn-primary" disabled={disabled}>Create invite link</SubmitButton>
      </div>
    </form>
  );
}
