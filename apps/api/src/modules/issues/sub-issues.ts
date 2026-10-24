import { and, asc, eq, sql } from "drizzle-orm";
import { schema } from "../../db";
import { ServiceError } from "../../common/service-error";
import type { Q, Tx } from "../../lib/service";

/**
 * Sub-issues: an issue can sit under another issue of its own team, as deep as MAX_ISSUE_DEPTH levels (a guard against a runaway
 * chain, not a product limit anyone should meet). The one thing that must never happen is a loop (an issue under its own
 * descendant), and it is refused here, not by the database: a loop has no single row to check, only the chain above the new parent.
 *
 * The check is one recursive query up the parent chain, which is as many primary-key lookups as the chain is long. A closure table
 * would make it constant, but every re-parent would then rewrite the moved issue's whole subtree, and that is the common edit.
 * Two people moving A under B and B under A at the same moment would each pass the check, so a re-parent takes the team's row
 * lock first, as cycles do, and the second one checks against the first one's result.
 */

const { issues, teams, statuses } = schema;

export const MAX_ISSUE_DEPTH = 50;

const rowsOf = <T>(res: unknown): T[] => (Array.isArray(res) ? res : ((res as { rows?: T[] }).rows ?? [])) as T[];

/** The levels from `id` up to its top-level issue, counting `id` itself (1 for an issue with no parent). */
async function depthAbove(q: Q, id: string): Promise<number> {
  const res = await q.execute(sql`
    with recursive up(id, parent_id, depth) as (
      select id, parent_id, 1 from issues where id = ${id}::uuid
      union all
      select i.id, i.parent_id, up.depth + 1 from issues i join up on i.id = up.parent_id where up.depth < ${MAX_ISSUE_DEPTH}
    )
    select max(depth)::int as depth from up`);
  return rowsOf<{ depth: number | null }>(res)[0]?.depth ?? 0;
}

/** The levels from `id` down to its deepest sub-issue, counting `id` itself (1 for an issue with no sub-issues). */
async function heightBelow(q: Q, id: string): Promise<number> {
  const res = await q.execute(sql`
    with recursive down(id, depth) as (
      select id, 1 from issues where id = ${id}::uuid
      union all
      select i.id, down.depth + 1 from issues i join down on i.parent_id = down.id where down.depth < ${MAX_ISSUE_DEPTH}
    )
    select max(depth)::int as depth from down`);
  return rowsOf<{ depth: number | null }>(res)[0]?.depth ?? 1;
}

/** Whether `ancestor` is `id` or sits somewhere above it. */
async function isSelfOrAncestor(q: Q, ancestor: string, id: string): Promise<boolean> {
  const res = await q.execute(sql`
    with recursive up(id, parent_id, depth) as (
      select id, parent_id, 1 from issues where id = ${id}::uuid
      union all
      select i.id, i.parent_id, up.depth + 1 from issues i join up on i.id = up.parent_id where up.depth < ${MAX_ISSUE_DEPTH}
    )
    select 1 as hit from up where id = ${ancestor}::uuid limit 1`);
  return rowsOf(res).length > 0;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The id of the issue to put `childId` under, from a ref ("WH-12") or an id, or null for none. `childId` is null for an issue that
 * does not exist yet. Throws when the parent is not in the team, would make a loop, or would nest too deep.
 */
export async function resolveParent(tx: Tx, team: { id: string; key: string }, childId: string | null, parentRef: string | null): Promise<string | null> {
  if (parentRef === null) return null;
  let parent: { id: string; number: number } | undefined;
  if (UUID_RE.test(parentRef)) {
    [parent] = await tx.select({ id: issues.id, number: issues.number }).from(issues).where(and(eq(issues.id, parentRef), eq(issues.teamId, team.id)));
  } else {
    const m = /^([A-Za-z]+)-(\d+)$/.exec(parentRef.trim());
    if (!m) throw new ServiceError("invalid", `Bad parent "${parentRef}" (use an issue ref like ${team.key}-12)`);
    if (m[1].toUpperCase() !== team.key.toUpperCase()) throw new ServiceError("invalid", `A sub-issue is in the same team as its parent: ${parentRef} is not in ${team.key}`);
    [parent] = await tx.select({ id: issues.id, number: issues.number }).from(issues).where(and(eq(issues.teamId, team.id), eq(issues.number, Number(m[2]))));
  }
  if (!parent) throw new ServiceError("invalid", `Parent issue ${parentRef} not found in ${team.key}`);

  if (childId) {
    // Loops come from re-parenting an issue that already exists; look at the chain only once nobody else is moving issues in this team.
    await tx.select({ id: teams.id }).from(teams).where(eq(teams.id, team.id)).for("update");
    if (await isSelfOrAncestor(tx, childId, parent.id)) {
      throw new ServiceError("invalid", `${team.key}-${parent.number} cannot be the parent: it is that issue or one of its sub-issues`);
    }
  }
  const above = await depthAbove(tx, parent.id);
  const below = childId ? await heightBelow(tx, childId) : 1;
  if (above + below > MAX_ISSUE_DEPTH) throw new ServiceError("invalid", `Sub-issues can be nested at most ${MAX_ISSUE_DEPTH} levels deep`);
  return parent.id;
}


export type IssueRelative = { ref: string; title: string; priority: (typeof schema.PRIORITIES)[number]; status: string; done: boolean; canceled: boolean; assigneeId: string | null };

/** An issue's parent and its direct sub-issues (in number order), each with the name and kind of its status, so progress can be shown. */
export async function relatives(q: Q, team: { id: string; key: string }, issue: { id: string; parentId: string | null }) {
  const pick = { number: issues.number, title: issues.title, priority: issues.priority, assigneeId: issues.assigneeId, status: statuses.name, role: statuses.role };
  const view = (r: { number: number; title: string; priority: IssueRelative["priority"]; assigneeId: string | null; status: string; role: string | null }): IssueRelative => ({
    ref: `${team.key}-${r.number}`,
    title: r.title,
    priority: r.priority,
    status: r.status,
    done: r.role === "done",
    canceled: r.role === "canceled",
    assigneeId: r.assigneeId,
  });
  const [parent] = issue.parentId ? await q.select(pick).from(issues).innerJoin(statuses, eq(statuses.id, issues.statusId)).where(eq(issues.id, issue.parentId)) : [];
  const children = await q.select(pick).from(issues).innerJoin(statuses, eq(statuses.id, issues.statusId)).where(eq(issues.parentId, issue.id)).orderBy(asc(issues.number));
  return { parent: parent ? view(parent) : null, children: children.map(view) };
}
