import { useActionState } from "react";
import { failure, field, type FormState } from "../lib/form-state";
import { refreshAll } from "../lib/refresh";
import { useServices } from "../lib/services";
import { SecretBox } from "./secret-box";
import { SubmitButton } from "./submit-button";
import { Select } from "./ui";

/** Create an invite link. `kind` decides what the link does; the server decides who may create it. */
export function InviteForm({ kind, disabled = false, className = "mt-4" }: { kind: "join_team" | "new_team"; disabled?: boolean; /** Spacing around the form (the default sits it below a heading). */ className?: string }) {
  const { api, queryClient } = useServices();
  const [state, action] = useActionState<FormState, FormData>(async (_prev, fd) => {
    try {
      const inv = await api.invites.create({
        kind,
        email: field(fd, "email"),
        role: field(fd, "role") === "owner" ? "owner" : "member",
        tags: field(fd, "tags"),
        team: field(fd, "team"),
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
      {kind === "join_team" ? (
        <>
          <Select name="role" defaultValue="member" options={[{ value: "member", label: "member" }, { value: "owner", label: "owner" }]} />
          <input className="input" name="tags" placeholder="tags: backend, design" disabled={disabled} />
        </>
      ) : (
        <input className="input sm:col-span-2" name="team" placeholder="Team name (optional)" maxLength={100} />
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
