"use client";

import { useActionState } from "react";
import { createInviteAction, type FormState } from "@/app/actions";
import { Select } from "@/components/ui";
import { SecretBox } from "@/components/secret-box";

/** Create an invite link. `kind` decides what the link does; the server decides who may create it. */
export function InviteForm({ kind, disabled = false }: { kind: "join_team" | "new_team"; disabled?: boolean }) {
  const [state, action, pending] = useActionState<FormState, FormData>(createInviteAction, undefined);
  return (
    <form action={action} className="mt-4 grid gap-3 sm:grid-cols-2">
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
        <button className="btn btn-primary" disabled={pending || disabled}>Create invite link</button>
      </div>
    </form>
  );
}
