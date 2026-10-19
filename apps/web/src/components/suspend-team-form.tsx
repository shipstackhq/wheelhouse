import { useActionState } from "react";
import { failure, field, type FormState } from "../lib/form-state";
import { refreshAll } from "../lib/refresh";
import { useServices } from "../lib/services";
import { SubmitButton } from "./submit-button";

/** Suspending needs the workspace's exact name typed in, so it cannot happen by a stray click. */
export function SuspendTeamForm({ teamId, teamName, members }: { teamId: string; teamName: string; members: number }) {
  const { api, queryClient } = useServices();
  const [state, action] = useActionState<FormState, FormData>(async (_prev, fd) => {
    try {
      const r = await api.admin.suspend(teamId, { confirm: field(fd, "confirm"), reason: field(fd, "reason") });
      void refreshAll(queryClient);
      return { ok: `Suspended ${r.name}. ${r.sessionsEnded} sign-in${r.sessionsEnded === 1 ? "" : "s"} ended.` };
    } catch (e) {
      return failure(e);
    }
  }, undefined);
  return (
    <form action={action} className="mt-4 space-y-3">
      <p className="text-sm text-muted">
        Signs out all {members} member{members === 1 ? "" : "s"} now, blocks their sign-in and every API key of this workspace,
        and stops its invites. Nothing is deleted; you can restore the workspace at any time.
      </p>
      <input className="input" name="reason" placeholder="Reason (only you can see it)" maxLength={500} />
      <input className="input" name="confirm" placeholder={`Type "${teamName}" to confirm`} required autoComplete="off" />
      {state?.error && <p className="text-sm text-danger">{state.error}</p>}
      {state?.ok && <p className="text-sm text-ok">{state.ok}</p>}
      <SubmitButton className="btn btn-danger">Suspend workspace</SubmitButton>
    </form>
  );
}
