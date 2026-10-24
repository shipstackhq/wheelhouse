import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { getDb, schema } from "../../db";
import type { InitiativeStatus, ProjectHealth } from "../../db/schema";
import type { Actor } from "../../lib/access";
import { bad, day, deriveHealth, oneOf, openProject, text, workspaceEvent, type HealthView, type ProgressCounts } from "./projects";
import type { Q, Tx } from "../../lib/service";
import { ServiceError } from "../../lib/service-error";
import { isUuid, workspaceRoleOf } from "../teams/team-access";

/**
 * Initiatives (WH-119): a goal that groups projects and other initiatives, up to three levels deep. It belongs to the workspace and
 * every member except a guest sees it. Its progress is rolled up from the issues of the projects linked to it and to the
 * initiatives under it, an issue once however many links reach it. What an initiative shows of a project follows the project's own
 * rule (ADR-23): a project of one of the viewer's teams is shown in full, any other only adds to the counts and the totals, with no
 * name and no issue. No initiative page ever lists an issue.
 */

const { initiatives, initiativeProjects, projects, issues, statuses, users, memberships } = schema;
export type InitiativeRow = typeof initiatives.$inferSelect;
const MAX_DEPTH = schema.INITIATIVE_MAX_DEPTH;

// ───────── who may do what ─────────

type Who = { role: schema.WorkspaceRole; isAdmin: boolean };

function humanOnly(actor: Actor) {
  if (actor.kind !== "human" || actor.system) throw new ServiceError("forbidden", "Only teammates work with initiatives");
}

/** Everyone but a guest can read; the workspace's owners and admins can also edit any initiative, others only their own. */
async function whoIs(q: Q, actor: Actor): Promise<Who> {
  humanOnly(actor);
  const role = await workspaceRoleOf(q, actor.workspaceId, actor.id);
  if (!role || role === "guest") throw new ServiceError("not_found", "Initiative not found");
  return { role, isAdmin: role === "owner" || role === "admin" };
}

const mayCreate = (w: Who) => w.role !== "viewer";
const mayEdit = (w: Who, actor: Actor, i: Pick<InitiativeRow, "ownerId">) => w.isAdmin || (w.role !== "viewer" && i.ownerId === actor.id);

async function liveInitiatives(q: Q, workspaceId: string): Promise<InitiativeRow[]> {
  return q.select().from(initiatives).where(and(eq(initiatives.workspaceId, workspaceId), isNull(initiatives.deletedAt)));
}

type Tree = { byId: Map<string, InitiativeRow>; kids: Map<string | null, InitiativeRow[]> };

function treeOf(rows: InitiativeRow[]): Tree {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const kids = new Map<string | null, InitiativeRow[]>();
  for (const r of rows) {
    const k = r.parentId && byId.has(r.parentId) ? r.parentId : null;
    kids.set(k, [...(kids.get(k) ?? []), r]);
  }
  for (const list of kids.values()) list.sort((a, b) => a.position - b.position || a.createdAt.getTime() - b.createdAt.getTime());
  return { byId, kids };
}

/** The initiative and everything under it. */
function subtree(t: Tree, id: string): InitiativeRow[] {
  const out: InitiativeRow[] = [];
  const walk = (i: string) => {
    const row = t.byId.get(i);
    if (!row) return;
    out.push(row);
    for (const c of t.kids.get(i) ?? []) walk(c.id);
  };
  walk(id);
  return out;
}

/** How many levels the initiative sits at (1 for a top one). */
function depthOf(t: Tree, id: string): number {
  let d = 1;
  for (let cur = t.byId.get(id); cur?.parentId && t.byId.has(cur.parentId); cur = t.byId.get(cur.parentId)) d++;
  return d;
}

/** How many levels the initiative and its sub-initiatives take (1 for one with none under it). */
function heightOf(t: Tree, id: string): number {
  return 1 + Math.max(0, ...(t.kids.get(id) ?? []).map((c) => heightOf(t, c.id)));
}

/**
 * Can `id` sit under `parentId` (null for the top)? Not under itself or anything below it, and not so deep that it or what is under
 * it goes past three levels.
 */
function checkParent(t: Tree, id: string | null, parentId: string | null) {
  if (parentId === null) return;
  if (!t.byId.has(parentId)) bad("parentId", "That parent initiative does not exist");
  if (id !== null && subtree(t, id).some((r) => r.id === parentId)) bad("parentId", "An initiative cannot sit under itself or under one of its own sub-initiatives");
  const below = id === null ? 1 : heightOf(t, id);
  if (depthOf(t, parentId) + below > MAX_DEPTH) bad("parentId", `Initiatives nest at most ${MAX_DEPTH} levels deep`);
}

// ───────── roll-up ─────────

type Linked = Map<string, string[]>; // initiative → its linked projects

async function linksOf(q: Q, ids: string[]): Promise<Linked> {
  const out: Linked = new Map(ids.map((i) => [i, []]));
  if (!ids.length) return out;
  const rows = await q
    .select({ initiativeId: initiativeProjects.initiativeId, projectId: initiativeProjects.projectId })
    .from(initiativeProjects)
    .innerJoin(projects, eq(projects.id, initiativeProjects.projectId))
    .where(and(inArray(initiativeProjects.initiativeId, ids), isNull(projects.deletedAt)));
  for (const r of rows) out.get(r.initiativeId)!.push(r.projectId);
  return out;
}

async function projectProgress(q: Q, projectIds: string[]): Promise<Map<string, ProgressCounts>> {
  const out = new Map<string, ProgressCounts>(projectIds.map((id) => [id, { total: 0, done: 0 }]));
  if (!projectIds.length) return out;
  const rows = await q
    .select({ projectId: issues.projectId, total: sql<number>`count(*) filter (where ${statuses.role} is distinct from 'canceled')::int`, done: sql<number>`count(*) filter (where ${statuses.role} = 'done')::int` })
    .from(issues)
    .innerJoin(statuses, eq(statuses.id, issues.statusId))
    .where(inArray(issues.projectId, projectIds))
    .groupBy(issues.projectId);
  for (const r of rows) out.set(r.projectId!, { total: Number(r.total), done: Number(r.done) });
  return out;
}

/**
 * The projects an initiative reaches: its own links and those of every initiative under it, each project once. An issue is in one
 * project, so summing over this set counts an issue once however many links lead to its project.
 */
export function reachableProjects(t: Tree, linked: Linked, id: string): string[] {
  return [...new Set(subtree(t, id).flatMap((i) => linked.get(i.id) ?? []))];
}

const sum = (ids: string[], progress: Map<string, ProgressCounts>): ProgressCounts =>
  ids.reduce((acc, p) => ({ total: acc.total + (progress.get(p)?.total ?? 0), done: acc.done + (progress.get(p)?.done ?? 0) }), { total: 0, done: 0 });

/** How an initiative is going: only an active one has a health, and one set by hand wins. The same reading as a project, from its target date. */
export function initiativeHealth(i: Pick<InitiativeRow, "status" | "targetDate" | "healthOverride">, progress: ProgressCounts, now: Date): HealthView {
  const derived: ProjectHealth | null = deriveHealth({ status: i.status === "active" ? "active" : "planned", startDate: null, targetDate: i.targetDate }, progress, now);
  return { derived, override: i.healthOverride ?? null, value: i.healthOverride ?? derived };
}

// ───────── reading ─────────

export type InitiativeSummary = {
  id: string;
  parentId: string | null;
  name: string;
  description: string;
  status: InitiativeStatus;
  health: HealthView;
  targetDate: string | null;
  owner: { id: string; name: string } | null;
  /** Rolled up from the issues of every project below, each issue once. */
  total: number;
  done: number;
  /** Projects linked to this initiative itself, and how many initiatives sit directly under it. */
  projectCount: number;
  childCount: number;
  /** 1 for a top initiative. */
  depth: number;
  version: number;
  canEdit: boolean;
  updatedAt: Date;
};

type Context = { tree: Tree; linked: Linked; progress: Map<string, ProgressCounts>; owners: Map<string, string>; who: Who };

async function context(q: Q, actor: Actor, who: Who): Promise<Context> {
  const rows = await liveInitiatives(q, actor.workspaceId);
  const tree = treeOf(rows);
  const linked = await linksOf(q, rows.map((r) => r.id));
  const progress = await projectProgress(q, [...new Set([...linked.values()].flat())]);
  const ownerIds = [...new Set(rows.map((r) => r.ownerId).filter((x): x is string => !!x))];
  const owners = new Map((ownerIds.length ? await q.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ownerIds)) : []).map((u) => [u.id, u.name]));
  return { tree, linked, progress, owners, who };
}

function summarise(c: Context, actor: Actor, i: InitiativeRow, now: Date): InitiativeSummary {
  const pr = sum(reachableProjects(c.tree, c.linked, i.id), c.progress);
  return {
    id: i.id,
    parentId: i.parentId && c.tree.byId.has(i.parentId) ? i.parentId : null,
    name: i.name,
    description: i.description,
    status: i.status,
    health: initiativeHealth(i, pr, now),
    targetDate: i.targetDate,
    owner: i.ownerId && c.owners.has(i.ownerId) ? { id: i.ownerId, name: c.owners.get(i.ownerId)! } : null,
    total: pr.total,
    done: pr.done,
    projectCount: c.linked.get(i.id)?.length ?? 0,
    childCount: c.tree.kids.get(i.id)?.length ?? 0,
    depth: depthOf(c.tree, i.id),
    version: i.version,
    canEdit: mayEdit(c.who, actor, i),
    updatedAt: i.updatedAt,
  };
}

/** Every initiative of the workspace as a flat list in tree order (a parent before its children), for the list page to indent. A guest sees none. */
export async function listInitiatives(actor: Actor, now = new Date()): Promise<InitiativeSummary[]> {
  humanOnly(actor);
  const db = await getDb();
  const role = await workspaceRoleOf(db, actor.workspaceId, actor.id);
  if (!role || role === "guest") return [];
  const c = await context(db, actor, { role, isAdmin: role === "owner" || role === "admin" });
  const out: InitiativeSummary[] = [];
  const walk = (parent: string | null) => {
    for (const i of c.tree.kids.get(parent) ?? []) {
      out.push(summarise(c, actor, i, now));
      walk(i.id);
    }
  };
  walk(null);
  return out;
}

export type InitiativeProjectView = { id: string; name: string; status: schema.ProjectStatus; health: HealthView; targetDate: string | null; total: number; done: number; direct: boolean };
export type InitiativeDetail = InitiativeSummary & {
  /** From the top initiative down to the parent. */
  path: { id: string; name: string }[];
  children: InitiativeSummary[];
  /** Projects of the viewer's teams that the initiative reaches. `direct`: linked here, not only through a sub-initiative. */
  projects: InitiativeProjectView[];
  /** The rest of the projects it reaches: how many, and their issue totals. Never a name. */
  hidden: { count: number; total: number; done: number };
  /** Projects the viewer sees that are not linked here yet, if they can edit. */
  linkable: { id: string; name: string }[];
};

export async function getInitiative(actor: Actor, id: string, now = new Date()): Promise<InitiativeDetail> {
  const db = await getDb();
  const who = await whoIs(db, actor);
  const c = await context(db, actor, who);
  const row = isUuid(id) ? c.tree.byId.get(id) : undefined;
  if (!row) throw new ServiceError("not_found", "Initiative not found");
  const summary = summarise(c, actor, row, now);
  const path: { id: string; name: string }[] = [];
  for (let p = row.parentId ? c.tree.byId.get(row.parentId) : undefined; p; p = p.parentId ? c.tree.byId.get(p.parentId) : undefined) path.unshift({ id: p.id, name: p.name });
  const reach = reachableProjects(c.tree, c.linked, id);
  const direct = new Set(c.linked.get(id) ?? []);
  const seen = new Set(
    (await db.select({ id: schema.projectVisibility.projectId }).from(schema.projectVisibility).where(eq(schema.projectVisibility.userId, actor.id))).map((r) => r.id),
  );
  const mineIds = reach.filter((p) => seen.has(p));
  const pRows = mineIds.length ? await db.select().from(projects).where(inArray(projects.id, mineIds)) : [];
  const projectViews: InitiativeProjectView[] = pRows
    .map((p) => {
      const pr = c.progress.get(p.id) ?? { total: 0, done: 0 };
      return { id: p.id, name: p.name, status: p.status, health: projectHealth(p, pr, now), targetDate: p.targetDate, total: pr.total, done: pr.done, direct: direct.has(p.id) };
    })
    .sort((a, b) => Number(b.direct) - Number(a.direct) || a.name.localeCompare(b.name));
  const hiddenIds = reach.filter((p) => !seen.has(p));
  const hidden = { count: hiddenIds.length, ...sum(hiddenIds, c.progress) };
  let linkable: { id: string; name: string }[] = [];
  if (summary.canEdit) {
    const mine = await db
      .select({ id: projects.id, name: projects.name })
      .from(projects)
      .innerJoin(schema.projectVisibility, eq(schema.projectVisibility.projectId, projects.id))
      .where(and(eq(schema.projectVisibility.userId, actor.id), eq(projects.workspaceId, actor.workspaceId), isNull(projects.deletedAt)));
    linkable = mine.filter((p) => !direct.has(p.id)).sort((a, b) => a.name.localeCompare(b.name));
  }
  return {
    ...summary,
    path,
    children: (c.tree.kids.get(id) ?? []).map((k) => summarise(c, actor, k, now)),
    projects: projectViews,
    hidden,
    linkable,
  };
}

function projectHealth(p: typeof projects.$inferSelect, pr: ProgressCounts, now: Date): HealthView {
  const derived = deriveHealth(p, pr, now);
  return { derived, override: p.healthOverride ?? null, value: p.healthOverride ?? derived };
}

// ───────── writing ─────────

export type InitiativeInput = {
  name?: unknown;
  description?: unknown;
  status?: unknown;
  targetDate?: unknown;
  /** A member of the workspace (not a guest); null for nobody. */
  owner?: unknown;
  /** The initiative it sits under; null for a top one. */
  parentId?: unknown;
  /** `null` clears the health that was set by hand. */
  healthOverride?: unknown;
  /** Its place among its siblings, from 0. */
  index?: unknown;
  /** The version last read, for an update. */
  version?: unknown;
};

async function ownerMember(q: Q, actor: Actor, v: unknown): Promise<string | null | undefined> {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  if (!isUuid(v)) return bad("owner", "owner must be a person's id");
  const [m] = await q.select({ role: memberships.role }).from(memberships).where(and(eq(memberships.workspaceId, actor.workspaceId), eq(memberships.userId, v)));
  if (!m || m.role === "guest") return bad("owner", "The owner must be a member of the workspace (not a guest)");
  return v;
}

function parentOf(v: unknown): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  if (!isUuid(v)) return bad("parentId", "parentId must be an initiative id, or null for a top one");
  return v;
}

function indexOf(v: unknown): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) return bad("index", "index must be a position from 0");
  return v;
}

/** The position that puts an initiative at `index` among its siblings (without itself). */
function positionAt(siblings: InitiativeRow[], index: number): number {
  const before = siblings[index - 1]?.position;
  const after = siblings[index]?.position;
  return before === undefined && after === undefined ? 1000 : before === undefined ? after! - 1000 : after === undefined ? before + 1000 : (before + after) / 2;
}

async function lockInitiative(tx: Tx, id: string, expected?: unknown) {
  const [row] = await tx.select().from(initiatives).where(eq(initiatives.id, id)).for("update");
  if (!row || row.deletedAt) throw new ServiceError("not_found", "Initiative not found");
  if (typeof expected === "number" && expected !== row.version) throw new ServiceError("conflict", `The initiative was changed (version ${row.version}, you had ${expected}). Re-read and retry.`, { current: row });
  return row;
}

/** Lock the workspace's initiatives so two moves cannot, between them, make a cycle or go past the depth limit. */
async function lockTree(tx: Tx, workspaceId: string) {
  await tx.execute(sql`select id from initiatives where workspace_id = ${workspaceId} for update`);
}

export async function createInitiative(actor: Actor, input: InitiativeInput, now = new Date()): Promise<InitiativeDetail> {
  const db = await getDb();
  const who = await whoIs(db, actor);
  if (!mayCreate(who)) throw new ServiceError("forbidden", "Viewers cannot create initiatives");
  const name = text(input.name, "name", 120, true)!;
  const description = text(input.description, "description", 20_000) ?? "";
  const status = oneOf(input.status, schema.INITIATIVE_STATUSES, "status") ?? "planned";
  const targetDate = day(input.targetDate, "targetDate") ?? null;
  const healthOverride = oneOf(input.healthOverride, schema.PROJECT_HEALTH, "healthOverride") ?? null;
  const owner = (await ownerMember(db, actor, input.owner)) ?? actor.id;
  const parentId = parentOf(input.parentId) ?? null;
  const created = await db.transaction(async (tx) => {
    await lockTree(tx, actor.workspaceId);
    const t = treeOf(await liveInitiatives(tx, actor.workspaceId));
    checkParent(t, null, parentId);
    const parent = parentId ? t.byId.get(parentId)! : null;
    if (parent && !mayEdit(who, actor, parent)) throw new ServiceError("forbidden", "Only the owner of an initiative, or a workspace admin, can add one under it");
    const sibs = t.kids.get(parentId) ?? [];
    const position = (sibs.at(-1)?.position ?? 0) + 1000;
    const [i] = await tx.insert(initiatives).values({ workspaceId: actor.workspaceId, parentId, name, description, ownerId: owner, status, targetDate, healthOverride, position }).returning();
    await workspaceEvent(tx, actor, { entity: "initiative", type: "initiative.created", entityId: i.id, summary: `created initiative "${i.name}"${parent ? ` under "${parent.name}"` : ""}`, data: { parentId, status } });
    return i;
  });
  return getInitiative(actor, created.id, now);
}

export async function updateInitiative(actor: Actor, id: string, patch: InitiativeInput, now = new Date()): Promise<InitiativeDetail> {
  const db = await getDb();
  const who = await whoIs(db, actor);
  const name = text(patch.name, "name", 120, patch.name !== undefined);
  const description = text(patch.description, "description", 20_000);
  const status = oneOf(patch.status, schema.INITIATIVE_STATUSES, "status");
  const targetDate = day(patch.targetDate, "targetDate");
  const healthOverride = patch.healthOverride === null ? null : oneOf(patch.healthOverride, schema.PROJECT_HEALTH, "healthOverride");
  const owner = await ownerMember(db, actor, patch.owner);
  const parentId = parentOf(patch.parentId);
  const index = indexOf(patch.index);
  await db.transaction(async (tx) => {
    await lockTree(tx, actor.workspaceId);
    const cur = await lockInitiative(tx, isUuid(id) ? id : "00000000-0000-0000-0000-000000000000", patch.version);
    if (cur.workspaceId !== actor.workspaceId) throw new ServiceError("not_found", "Initiative not found");
    if (!mayEdit(who, actor, cur)) throw new ServiceError("forbidden", "Only the owner of an initiative, or a workspace admin, can change it");
    const t = treeOf(await liveInitiatives(tx, actor.workspaceId));
    const set: Partial<typeof initiatives.$inferInsert> = {};
    if (name !== undefined && name !== cur.name) set.name = name;
    if (description !== undefined && description !== cur.description) set.description = description;
    if (status !== undefined && status !== cur.status) set.status = status;
    if (targetDate !== undefined && targetDate !== cur.targetDate) set.targetDate = targetDate;
    if (healthOverride !== undefined && healthOverride !== cur.healthOverride) set.healthOverride = healthOverride;
    if (owner !== undefined && owner !== cur.ownerId) set.ownerId = owner;
    const moves = parentId !== undefined && parentId !== cur.parentId;
    if (moves) {
      checkParent(t, id, parentId!);
      const to = parentId ? t.byId.get(parentId)! : null;
      if (to && !mayEdit(who, actor, to)) throw new ServiceError("forbidden", "Only the owner of an initiative, or a workspace admin, can move one under it");
      set.parentId = parentId!;
    }
    if (moves || index !== undefined) {
      const dest = moves ? parentId! : cur.parentId;
      const sibs = (t.kids.get(dest) ?? []).filter((s) => s.id !== id);
      const position = index !== undefined ? positionAt(sibs, Math.min(index, sibs.length)) : (sibs.at(-1)?.position ?? 0) + 1000;
      if (position !== cur.position) set.position = position;
    }
    if (!Object.keys(set).length) return;
    const [u] = await tx.update(initiatives).set({ ...set, version: cur.version + 1, updatedAt: new Date() }).where(eq(initiatives.id, id)).returning();
    const changed = Object.keys(set);
    await workspaceEvent(tx, actor, {
      entity: "initiative",
      type: "initiative.updated",
      entityId: id,
      summary: `updated initiative "${u.name}": ${changed.join(", ")}`,
      data: { changed, from: Object.fromEntries(changed.map((k) => [k, (cur as Record<string, unknown>)[k]])), to: Object.fromEntries(changed.map((k) => [k, (u as Record<string, unknown>)[k]])) },
    });
  });
  return getInitiative(actor, id, now);
}

/**
 * Delete an initiative (soft). The initiatives under it move up to its parent, so nothing goes past the depth limit and nothing is
 * lost; its links to projects go, and the projects themselves are left as they are.
 */
export async function deleteInitiative(actor: Actor, id: string) {
  const db = await getDb();
  const who = await whoIs(db, actor);
  return db.transaction(async (tx) => {
    await lockTree(tx, actor.workspaceId);
    const cur = await lockInitiative(tx, isUuid(id) ? id : "00000000-0000-0000-0000-000000000000");
    if (cur.workspaceId !== actor.workspaceId) throw new ServiceError("not_found", "Initiative not found");
    if (!mayEdit(who, actor, cur)) throw new ServiceError("forbidden", "Only the owner of an initiative, or a workspace admin, can delete it");
    const t = treeOf(await liveInitiatives(tx, actor.workspaceId));
    const kids = t.kids.get(id) ?? [];
    const siblings = (t.kids.get(cur.parentId) ?? []).filter((s) => s.id !== id);
    let position = (siblings.at(-1)?.position ?? 0) + 1000;
    for (const k of kids) {
      await tx.update(initiatives).set({ parentId: cur.parentId, position, version: k.version + 1, updatedAt: new Date() }).where(eq(initiatives.id, k.id));
      position += 1000;
    }
    const links = await tx.delete(initiativeProjects).where(eq(initiativeProjects.initiativeId, id)).returning({ id: initiativeProjects.projectId });
    await tx.update(initiatives).set({ deletedAt: new Date(), version: cur.version + 1, updatedAt: new Date() }).where(eq(initiatives.id, id));
    await workspaceEvent(tx, actor, {
      entity: "initiative",
      type: "initiative.deleted",
      entityId: id,
      summary: `deleted initiative "${cur.name}"${kids.length ? ` (${kids.length} below it moved up)` : ""}`,
      data: { name: cur.name, moved: kids.length, unlinked: links.length },
    });
    return { ok: true, moved: kids.length, unlinked: links.length };
  });
}

// ───────── linked projects ─────────

async function editable(q: Q, actor: Actor, id: string) {
  const who = await whoIs(q, actor);
  const [row] = isUuid(id) ? await q.select().from(initiatives).where(and(eq(initiatives.id, id), eq(initiatives.workspaceId, actor.workspaceId), isNull(initiatives.deletedAt))) : [];
  if (!row) throw new ServiceError("not_found", "Initiative not found");
  if (!mayEdit(who, actor, row)) throw new ServiceError("forbidden", "Only the owner of an initiative, or a workspace admin, can change what it groups");
  return row;
}

/** Link a project. The person must see it (a project of one of their teams); one they cannot see answers not found. */
export async function linkProject(actor: Actor, id: string, projectId: unknown, now = new Date()) {
  const db = await getDb();
  await editable(db, actor, id);
  if (!isUuid(projectId)) bad("projectId", "projectId must be a project id");
  const { project } = await openProject(db, actor, projectId as string, "read");
  await db.transaction(async (tx) => {
    const cur = await lockInitiative(tx, id);
    const [already] = await tx.select().from(initiativeProjects).where(and(eq(initiativeProjects.initiativeId, id), eq(initiativeProjects.projectId, project.id)));
    if (already) throw new ServiceError("conflict", `"${project.name}" is already in this initiative`);
    await tx.insert(initiativeProjects).values({ initiativeId: id, projectId: project.id, workspaceId: actor.workspaceId });
    await tx.update(initiatives).set({ version: cur.version + 1, updatedAt: new Date() }).where(eq(initiatives.id, id));
    await workspaceEvent(tx, actor, { entity: "initiative", type: "initiative.project_linked", entityId: id, summary: `added project "${project.name}" to initiative "${cur.name}"`, data: { projectId: project.id } });
  });
  return getInitiative(actor, id, now);
}

/** Unlink a project. The project and its issues are untouched. */
export async function unlinkProject(actor: Actor, id: string, projectId: string, now = new Date()) {
  const db = await getDb();
  await editable(db, actor, id);
  const { project } = await openProject(db, actor, projectId, "read");
  await db.transaction(async (tx) => {
    const cur = await lockInitiative(tx, id);
    const gone = await tx.delete(initiativeProjects).where(and(eq(initiativeProjects.initiativeId, id), eq(initiativeProjects.projectId, project.id))).returning();
    if (!gone.length) throw new ServiceError("not_found", "That project is not in this initiative");
    await tx.update(initiatives).set({ version: cur.version + 1, updatedAt: new Date() }).where(eq(initiatives.id, id));
    await workspaceEvent(tx, actor, { entity: "initiative", type: "initiative.project_unlinked", entityId: id, summary: `removed project "${project.name}" from initiative "${cur.name}"`, data: { projectId: project.id } });
  });
  return getInitiative(actor, id, now);
}
