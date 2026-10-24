import { asc, eq, sql } from "drizzle-orm";
import { getDb, schema } from "../../db";
import type { Actor } from "../../common/actor";
import { emit, requireTeam, type Q, type Tx } from "../../lib/service";
import { ServiceError } from "../../lib/service-error";
import { assertWritable, audit } from "./team-access";
import { REQUIRED_ROLES, ROLE_ORDER, STATUS_NAME_MAX, roleRank, type StatusRole } from "@wheelhouse/shared/status-roles";
import { TEAM_ICON_COLORS } from "./team-icon";

/**
 * A team's statuses, managed from its settings: add one in a role, rename or recolour it, make it its role's default, put them in
 * order, delete one (moving its issues to another). Team admins only, and people only: an agent works inside the statuses a team has.
 *
 * A status's role never changes once it is made, as in Linear; to put work in another stage, make a status in that stage. Every team
 * keeps at least one status in each required role, and statuses stay grouped by role (all the backlog ones, then todo, and so on)
 * so a board and a list can lay them out without sorting. Every status has a role.
 *
 * Every change takes the team's row lock, so two admins reordering or deleting at once are taken one after the other.
 */

const { statuses, issues, teams } = schema;

export type StatusView = {
  id: string;
  name: string;
  role: StatusRole;
  isDefault: boolean;
  color: (typeof TEAM_ICON_COLORS)[number] | null;
  position: number;
  /** How many issues are in it. */
  issueCount: number;
};

type Row = typeof statuses.$inferSelect;

const view = (r: Row, issueCount: number): StatusView => ({ id: r.id, name: r.name, role: r.role, isDefault: r.isDefault, color: r.color, position: r.position, issueCount });

const bad = (field: string, message: string): never => {
  throw new ServiceError("invalid", message, { fields: { [field]: message } });
};

async function adminOf(actor: Actor, teamRef: string) {
  if (actor.kind !== "human") throw new ServiceError("forbidden", "Only teammates can change a team's statuses");
  const team = await requireTeam(actor, teamRef, "admin");
  assertWritable(team);
  return team;
}

async function lockTeam(tx: Tx, teamId: string) {
  await tx.select({ id: teams.id }).from(teams).where(eq(teams.id, teamId)).for("update");
}

const rowsOf = (q: Q, teamId: string) => q.select().from(statuses).where(eq(statuses.teamId, teamId)).orderBy(asc(statuses.position), asc(statuses.id));

async function countIn(q: Q, statusId: string): Promise<number> {
  const [r] = await q.select({ n: sql<number>`count(*)::int` }).from(issues).where(eq(issues.statusId, statusId));
  return Number(r?.n ?? 0);
}

function cleanName(v: unknown): string {
  if (typeof v !== "string") return bad("name", "name must be text");
  const name = v.trim();
  if (!name) return bad("name", "A status needs a name");
  if (name.length > STATUS_NAME_MAX) return bad("name", `A status name has at most ${STATUS_NAME_MAX} characters`);
  return name;
}

function cleanColor(v: unknown): (typeof TEAM_ICON_COLORS)[number] | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== "string" || !(TEAM_ICON_COLORS as readonly string[]).includes(v)) return bad("color", `color must be one of ${TEAM_ICON_COLORS.join(", ")}, or null for the role's own`);
  return v as (typeof TEAM_ICON_COLORS)[number];
}

const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

function assertNameFree(rows: Row[], name: string, exceptId?: string) {
  if (rows.some((r) => r.id !== exceptId && sameName(r.name, name))) throw new ServiceError("conflict", `This team already has a status called "${name}"`, { fields: { name: "already taken" } });
}

/** A status of this team by id or by name (any case); not_found otherwise, so another team's id is simply not there. */
function pick(rows: Row[], ref: string): Row {
  const row = rows.find((r) => r.id === ref) ?? rows.find((r) => sameName(r.name, ref));
  if (!row) throw new ServiceError("not_found", `Status "${ref}" not found`);
  return row;
}

async function record(tx: Tx, actor: Actor, teamId: string, type: string, status: { id: string }, summary: string, data: Record<string, unknown>) {
  await audit(tx, actor, { action: type, targetType: "team", targetId: teamId, teamId, after: data });
  await emit(tx, actor, teamId, { type, entity: "status", entityId: status.id, summary, data });
}

export async function listStatuses(actor: Actor, teamRef: string): Promise<StatusView[]> {
  const db = await getDb();
  const team = await requireTeam(actor, teamRef, "read", db);
  const rows = await rowsOf(db, team.id);
  const counts = await db.select({ id: issues.statusId, n: sql<number>`count(*)::int` }).from(issues).where(eq(issues.teamId, team.id)).groupBy(issues.statusId);
  const by = new Map(counts.map((c) => [c.id, Number(c.n)]));
  return rows.map((r) => view(r, by.get(r.id) ?? 0));
}

/** `{ name, role, color? }`: a new status at the end of its role's group. The first status of a role is its default. */
export async function createStatus(actor: Actor, teamRef: string, input: { name?: unknown; role?: unknown; color?: unknown }): Promise<StatusView> {
  const team = await adminOf(actor, teamRef);
  const name = cleanName(input.name);
  if (typeof input.role !== "string" || !(ROLE_ORDER as readonly string[]).includes(input.role)) bad("role", `role must be one of ${ROLE_ORDER.join(", ")}`);
  const role = input.role as StatusRole;
  const color = cleanColor(input.color);
  const db = await getDb();
  return db.transaction(async (tx) => {
    await lockTeam(tx, team.id);
    const rows = await rowsOf(tx, team.id);
    assertNameFree(rows, name);
    // After the last status whose role is this one or an earlier one; before the next status, or a step on past the end.
    const rank = roleRank(role);
    const before = rows.filter((r) => r.role && roleRank(r.role) <= rank);
    const after = before.length ? before[before.length - 1] : null;
    const next = rows.find((r) => (after ? r.position > after.position : true));
    const position = after ? (next ? (after.position + next.position) / 2 : after.position + 1000) : next ? next.position / 2 : 1000;
    const [row] = await tx
      .insert(statuses)
      .values({ teamId: team.id, workspaceId: team.workspaceId, name, role, color: color ?? null, position, isDefault: !rows.some((r) => r.role === role && r.isDefault) })
      .returning();
    await record(tx, actor, team.id, "status.created", row, `added status "${name}" (${role})`, { name, role, isDefault: row.isDefault });
    return view(row, 0);
  });
}

/** `{ name?, color?, isDefault? }`. `isDefault` can only be set to true (make another status the default to move it). A role cannot change. */
export async function updateStatus(actor: Actor, teamRef: string, statusRef: string, patch: { name?: unknown; color?: unknown; isDefault?: unknown; role?: unknown }): Promise<StatusView> {
  const team = await adminOf(actor, teamRef);
  const db = await getDb();
  return db.transaction(async (tx) => {
    await lockTeam(tx, team.id);
    const rows = await rowsOf(tx, team.id);
    const row = pick(rows, statusRef);
    if (patch.role !== undefined && patch.role !== row.role) bad("role", "A status's role cannot change. Make a status in the other role and move its issues.");
    const next: Partial<Row> = {};
    if (patch.name !== undefined) {
      const name = cleanName(patch.name);
      if (name !== row.name) {
        assertNameFree(rows, name, row.id);
        next.name = name;
      }
    }
    const color = cleanColor(patch.color);
    if (color !== undefined && color !== row.color) next.color = color;
    let makeDefault = false;
    if (patch.isDefault !== undefined) {
      if (patch.isDefault !== true) bad("isDefault", "isDefault can only be set to true: make another status the default instead");
      makeDefault = !row.isDefault;
    }
    if (!Object.keys(next).length && !makeDefault) return view(row, await countIn(tx, row.id));
    if (makeDefault) {
      // The old default goes first: only one status of a role may be the default at any moment.
      await tx.update(statuses).set({ isDefault: false }).where(sql`${statuses.teamId} = ${team.id} and ${statuses.role} = ${row.role} and ${statuses.isDefault}`);
      next.isDefault = true;
    }
    const [updated] = await tx.update(statuses).set(next).where(eq(statuses.id, row.id)).returning();
    await record(tx, actor, team.id, "status.updated", updated, `updated status "${row.name}": ${Object.keys(next).join(", ")}`, { from: { name: row.name, color: row.color, isDefault: row.isDefault }, changes: next });
    return view(updated, await countIn(tx, row.id));
  });
}

/** `ids`: every status of the team, in the order wanted. Statuses with a role must stay grouped by role, in the order of the roles. */
export async function reorderStatuses(actor: Actor, teamRef: string, ids: unknown): Promise<StatusView[]> {
  const team = await adminOf(actor, teamRef);
  if (!Array.isArray(ids) || ids.some((i) => typeof i !== "string")) bad("ids", "ids must be a list of status ids");
  const want = ids as string[];
  const db = await getDb();
  await db.transaction(async (tx) => {
    await lockTeam(tx, team.id);
    const rows = await rowsOf(tx, team.id);
    const known = new Set(rows.map((r) => r.id));
    if (new Set(want).size !== want.length || want.length !== rows.length || want.some((i) => !known.has(i))) bad("ids", "ids must name every status of the team exactly once");
    const byId = new Map(rows.map((r) => [r.id, r]));
    let rank = -1;
    for (const id of want) {
      const role = byId.get(id)!.role;
      if (roleRank(role) < rank) bad("ids", `Statuses stay grouped by role (${ROLE_ORDER.join(", ")}): "${byId.get(id)!.name}" cannot come after a later role`);
      rank = roleRank(role);
    }
    const changed = want.map((id, i) => ({ id, position: (i + 1) * 1000 })).filter((c) => byId.get(c.id)!.position !== c.position);
    if (!changed.length) return;
    for (const c of changed) await tx.update(statuses).set({ position: c.position }).where(eq(statuses.id, c.id));
    await record(tx, actor, team.id, "status.reordered", { id: team.id }, `reordered the statuses of ${team.name}`, { order: want.map((id) => byId.get(id)!.name) });
  });
  return listStatuses(actor, teamRef);
}

/**
 * Delete a status. One with issues in it needs `moveTo` (an id or a name of another status of the team) to say where they go; they
 * keep their order and their version goes up. The last status of a required role cannot go. If it was its role's default, the next
 * one of that role (in board order) becomes the default.
 */
export async function deleteStatus(actor: Actor, teamRef: string, statusRef: string, moveToRef?: string | null): Promise<{ ok: true; deleted: string; moved: number }> {
  const team = await adminOf(actor, teamRef);
  const db = await getDb();
  return db.transaction(async (tx) => {
    await lockTeam(tx, team.id);
    const rows = await rowsOf(tx, team.id);
    const row = pick(rows, statusRef);
    const others = rows.filter((r) => r.id !== row.id);
    if ((REQUIRED_ROLES as readonly string[]).includes(row.role) && !others.some((r) => r.role === row.role)) {
      throw new ServiceError("conflict", `"${row.name}" is the team's last ${row.role} status; a team needs one`);
    }
    const count = await countIn(tx, row.id);
    let moved = 0;
    let target: Row | undefined;
    if (count > 0) {
      if (!moveToRef) throw new ServiceError("conflict", `${count} issue${count === 1 ? " is" : "s are"} in "${row.name}". Say which status they move to.`, { issues: count });
      target = pick(rows, moveToRef);
      if (target.id === row.id) bad("moveTo", "Issues cannot move to the status being deleted");
      // After what is already there, in the order they had.
      const [edge] = await tx
        .select({ top: sql<number>`coalesce(max(${issues.position}), 0)`, low: sql<number>`coalesce((select min(position) from issues where status_id = ${row.id}), 0)` })
        .from(issues)
        .where(eq(issues.statusId, target.id));
      const shift = Number(edge.top) - Number(edge.low) + 1000;
      await tx.execute(sql`update issues set status_id = ${target.id}, position = position + ${shift}, version = version + 1, updated_at = now() where status_id = ${row.id}`);
      moved = count;
    }
    await tx.delete(statuses).where(eq(statuses.id, row.id));
    if (row.isDefault) {
      const heir = others.find((r) => r.role === row.role);
      if (heir) await tx.update(statuses).set({ isDefault: true }).where(eq(statuses.id, heir.id));
    }
    await record(tx, actor, team.id, "status.deleted", row, `deleted status "${row.name}"${moved ? `, moving ${moved} issue${moved === 1 ? "" : "s"} to "${target!.name}"` : ""}`, { name: row.name, role: row.role, moved, to: target?.name ?? null });
    return { ok: true as const, deleted: row.name, moved };
  });
}
