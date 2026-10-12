import { eq } from "drizzle-orm";
import { requireHuman } from "@/lib/auth";
import { getDb, schema } from "@/db";
import { removeMember, updateMember } from "../../actions";
import { AddMemberForm, ChangePasswordForm } from "./forms";

export default async function TeamPage() {
  const { team, membership, user } = await requireHuman();
  const db = await getDb();
  const members = await db
    .select({ user: schema.users, m: schema.memberships })
    .from(schema.memberships)
    .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
    .where(eq(schema.memberships.teamId, team.id));
  const isOwner = membership.role === "owner";

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
                  <select name="role" defaultValue={m.role} className="input w-28 py-1.5">
                    <option value="owner">owner</option>
                    <option value="member">member</option>
                  </select>
                  <input name="tags" defaultValue={m.tags.join(", ")} placeholder="tags" className="input w-48 py-1.5" />
                  <button className="btn">Save</button>
                  {u.id !== user.id && (
                    <button formAction={removeMember} className="btn btn-danger">Remove</button>
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
            <h2 className="font-medium">Add member</h2>
            <p className="mt-1 text-sm text-muted">No invite emails yet — you&apos;ll get a temporary password to share with them.</p>
            <AddMemberForm />
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
