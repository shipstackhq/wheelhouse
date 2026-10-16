import { notFound } from "next/navigation";
import { requireHuman } from "@/lib/auth";
import { isInstanceAdmin } from "@wheelhouse/core/lib/auth-policy";
import { listInvites } from "@wheelhouse/core/lib/invites";
import { InviteForm } from "@/components/invite-form";
import { PendingInvites } from "@/components/pending-invites";

export const dynamic = "force-dynamic";

export default async function AdminInvitesPage() {
  const { user, team, membership } = await requireHuman();
  if (!isInstanceAdmin(user.email)) notFound(); // not an admin: the page does not exist
  const pending = (await listInvites({ userId: user.id, email: user.email, teamId: team.id, role: membership.role })).filter(
    (i) => i.kind === "new_team",
  );
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl space-y-8 px-6 py-10">
        <div>
          <h1 className="text-xl font-semibold">Invite a new team</h1>
          <p className="mt-1 text-sm text-muted">
            For people outside your team. They follow the link, choose a password and get their own team, which they own.
          </p>
        </div>
        <div className="card p-5">
          <InviteForm kind="new_team" />
          <h3 className="mt-6 text-sm font-medium">Pending invites</h3>
          <PendingInvites invites={pending} />
        </div>
      </div>
    </div>
  );
}
