import type { PendingInvite } from "@wheelhouse/api-client";
import { refreshAll } from "../lib/refresh";
import { useServices } from "../lib/services";
import { SubmitButton } from "./submit-button";

/** Pending invites with a Revoke button. The link itself is never shown again. */
export function PendingInvites({ invites }: { invites: PendingInvite[] }) {
  const { api, queryClient } = useServices();
  if (!invites.length) return <p className="mt-3 text-sm text-muted">No pending invites.</p>;
  return (
    <div className="mt-3 divide-y divide-line rounded-md border border-line">
      {invites.map((i) => (
        <form
          key={i.id}
          action={async () => {
            try {
              await api.invites.revoke(i.id);
            } catch {
              /* already used or revoked: the list is read again below and no longer shows it */
            }
            await refreshAll(queryClient);
          }}
          className="flex flex-wrap items-center gap-3 px-3 py-2 text-sm"
        >
          <div className="min-w-40 flex-1">
            <div className="font-medium">{i.email}</div>
            <div className="text-xs text-muted">
              {i.kind === "new_workspace" ? `new workspace${i.workspaceName ? `: ${i.workspaceName}` : ""}` : i.role}
              {i.projects.length > 0 && ` · joins ${i.projects.map((p) => `${p.key} as ${p.role}`).join(", ")}`} · expires {i.expiresAt.slice(0, 10)}
            </div>
          </div>
          <SubmitButton className="btn btn-danger">Revoke</SubmitButton>
        </form>
      ))}
    </div>
  );
}
