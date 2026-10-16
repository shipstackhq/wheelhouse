import { eq } from "drizzle-orm";
import { requireHuman } from "@/lib/auth";
import { getDb, schema } from "@wheelhouse/core/db";
import { removeMember, updateMember } from "../../actions";
import { Select } from "@/components/ui";
import { ChangePasswordForm } from "./forms";
import { InviteForm } from "@/components/invite-form";
import { PendingInvites } from "@/components/pending-invites";
import { listInvites, seatInfo } from "@wheelhouse/core/lib/invites";
import { SubmitButton } from "@/components/submit-button";

export default async function TeamPage() {
  const { team, membership, user } = await requireHuman();
  const db = await getDb();
  const members = await db
    .select({ user: schema.users, m: schema.memberships })
    .from(schema.memberships)
    .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
    .where(eq(schema.memberships.teamId, team.id));
  const isOwner = membership.role === "owner";
  const seats = await seatInfo(team.id);
  const pendingInvites = isOwner
    ? (await listInvites({ userId: user.id, email: user.email, teamId: team.id, role: membership.role })).filter((i) => i.kind === "join_team")
    : [];

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl space-y-8 px-6 py-10">
        <div>
          <h1 className="text-xl font-semibold">{team.name}</h1>
          <p className="mt-1 text-sm text-muted">Members, roles and tags. Tags are free-form (e.g. backend, design, pm).</p>
        </div>

        <div className="card divide-y divide-line">
          {members.map(({ user: u, m }) => (
            <form key={u.id} action={updateMember} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
              <input type="hidden" name="userId" value={u.id} />
              <div className="min-w-40 flex-1">
                <div className="font-medium">{u.name}{u.id === user.id && <span className="text-muted"> (you)</span>}</div>
                <div className="text-xs text-muted">{u.email}</div>
              </div>
              {isOwner ? (
                <>
                  <Select name="role" defaultValue={m.role} className="w-28" options={[{ value: "owner", label: "owner" }, { value: "member", label: "member" }]} />
                  <input name="tags" defaultValue={m.tags.join(", ")} placeholder="tags" className="input w-48 py-1.5" />
                  <SubmitButton className="btn">Save</SubmitButton>
                  {u.id !== user.id && (
                    <SubmitButton formAction={removeMember} className="btn btn-danger">Remove</SubmitButton>
                  )}
                </>
              ) : (
                <div className="flex gap-1">
                  <span className="chip bg-panel-2 text-fg">{m.role}</span>
                  {m.tags.map((t) => <span key={t} className="chip bg-bg text-muted">{t}</span>)}
                </div>
              )}
            </form>
          ))}
        </div>

        {isOwner && (
          <div className="card p-5">
            <div className="flex items-baseline justify-between gap-3">
              <h2 className="font-medium">Invite someone</h2>
              <span className="text-xs text-muted">
                {seats.used} of {seats.max} seats used ({seats.members} members, {seats.pending} pending)
              </span>
            </div>
            <p className="mt-1 text-sm text-muted">
              Creates a one-time link for one person. It works until it is used, revoked or expires, and is shown only once.
            </p>
            {seats.full && (
              <p className="mt-2 text-sm text-warn">Your team is full. Revoke a pending invite or remove a member to free a seat.</p>
            )}
            <InviteForm kind="join_team" disabled={seats.full} />
            <h3 className="mt-6 text-sm font-medium">Pending invites</h3>
            <PendingInvites invites={pendingInvites} />
          </div>
        )}

        <div className="card p-5">
          <h2 className="font-medium">Your password</h2>
          <ChangePasswordForm />
        </div>
      </div>
    </div>
  );
}
