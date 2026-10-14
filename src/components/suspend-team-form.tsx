"use client";

import { useActionState } from "react";
import { suspendTeamAction, type FormState } from "@/app/actions";

/** Suspending needs the team's exact name typed in, so it cannot happen by a stray click. */
export function SuspendTeamForm({ teamId, teamName, members }: { teamId: string; teamName: string; members: number }) {
  const [state, action, pending] = useActionState<FormState, FormData>(suspendTeamAction, undefined);
  return (
    <form action={action} className="mt-4 space-y-3">
      <input type="hidden" name="teamId" value={teamId} />
      <p className="text-sm text-muted">
        Signs out all {members} member{members === 1 ? "" : "s"} now, blocks their sign-in and every API key of this team,
        and stops its invites. Nothing is deleted; you can restore the team at any time.
      </p>
      <input className="input" name="reason" placeholder="Reason (only you can see it)" maxLength={500} />
      <input className="input" name="confirm" placeholder={`Type "${teamName}" to confirm`} required autoComplete="off" />
      {state?.error && <p className="text-sm text-danger">{state.error}</p>}
      {state?.ok && <p className="text-sm text-ok">{state.ok}</p>}
      <button className="btn btn-danger" disabled={pending}>Suspend team</button>
    </form>
  );
}
