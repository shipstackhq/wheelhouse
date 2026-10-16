import { revokeInviteAction } from "@/app/actions";
import type { PendingInvite } from "@wheelhouse/core/lib/invites";
import { SubmitButton } from "./submit-button";

/** Pending invites with a Revoke button. The link itself is never shown again. */
export function PendingInvites({ invites }: { invites: PendingInvite[] }) {
  if (!invites.length) return <p className="mt-3 text-sm text-muted">No pending invites.</p>;
  return (
    <div className="mt-3 divide-y divide-line rounded-md border border-line">
      {invites.map((i) => (
        <form key={i.id} action={revokeInviteAction} className="flex flex-wrap items-center gap-3 px-3 py-2 text-sm">
          <input type="hidden" name="id" value={i.id} />
          <div className="min-w-40 flex-1">
            <div className="font-medium">{i.email}</div>
            <div className="text-xs text-muted">
              {i.kind === "new_team" ? `new team${i.teamName ? `: ${i.teamName}` : ""}` : i.role} · expires {i.expiresAt.toISOString().slice(0, 10)}
            </div>
          </div>
          <SubmitButton className="btn btn-danger">Revoke</SubmitButton>
        </form>
      ))}
    </div>
  );
}
