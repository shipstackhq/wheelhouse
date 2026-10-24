import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { getDb, schema } from "../../db";
import type { Priority, ProjectHealth, ProjectStatus, TeamRole } from "../../db/schema";
import type { Actor } from "../../common/actor";
import { avatarUrl } from "../../lib/images";
import { emit, requireTeam, type Q, type Tx } from "../../lib/service";
import { ServiceError } from "../../common/service-error";
import { isUuid, roleAllows, teamRoleMap, workspaceRoleOf } from "../teams/team-access";

/**
 * Projects (WH-118): an outcome that ends and can span teams, with a lead, dates, milestones and a health worked out from its
 * issues and dates unless someone sets it. A project belongs to the workspace and is seen only by people on a team that takes part
 * (plan section 5): issue detail only for the viewer's own teams, and for the other teams just totals, never names or titles.
 * Guests see no projects. The database holds the other rules: an issue reaches a project only through its own team's row in
 * project_teams, a milestone belongs to that project, and the lead team takes part.
 */

const { projects, projectTeams, projectMilestones, projectVisibility, issues, statuses, teams, workspaceEvents, memberships, users } = schema;
export type ProjectRow = typeof projects.$inferSelect;

const DAY = 86_400_000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ───────── health, derived ─────────

export type ProgressCounts = { total: number; done: number };
export type HealthView = { derived: ProjectHealth | null; override: ProjectHealth | null; value: ProjectHealth | null };

const dayStart = (d: string) => Date.parse(`${d}T00:00:00.000Z`);

/**
 * How a project is going, from its issues and dates. Only an active project has a health; the one the people set (the override)
 * wins over it. Past its target date with work still open is off track; otherwise the share of time gone is compared with the
 * share of issues done (a gap over a quarter is at risk, over a half is off track). A project with no dates and no issues has
 * nothing to judge.
 */
export function deriveHealth(p: Pick<ProjectRow, "status" | "startDate" | "targetDate">, progress: ProgressCounts, now: Date): ProjectHealth | null {
  if (p.status !== "active") return null;
  const open = progress.total - progress.done;
  const finished = progress.total > 0 && open === 0;
  const end = p.targetDate ? dayStart(p.targetDate) + DAY : null; // the target day counts as a working day
  if (end !== null && now.getTime() >= end && !finished) return "off_track";
  if (finished) return "on_track";
  if (progress.total === 0) return null;
  const doneShare = progress.done / progress.total;
  if (end !== null) {
    const start = p.startDate ? dayStart(p.startDate) : null;
    if (start !== null && end > start) {
      const gap = Math.min(1, Math.max(0, (now.getTime() - start) / (end - start))) - doneShare;
      return gap > 0.5 ? "off_track" : gap > 0.25 ? "at_risk" : "on_track";
    }
    // Only an end: close and less than half done is at risk.
    return (end - now.getTime()) / DAY <= 3 && doneShare < 0.5 ? "at_risk" : "on_track";
  }
  return "on_track";
}

export const healthOf = (p: ProjectRow, progress: ProgressCounts, now: Date): HealthView => {
  const derived = deriveHealth(p, progress, now);
  return { derived, override: p.healthOverride ?? null, value: p.healthOverride ?? derived };
};

// ───────── who may do what ─────────

type Access = {
  project: ProjectRow;
  /** The teams of the project the person is on, with their role there. */
  mine: Map<string, TeamRole>;
  /** All the teams taking part. */
  teamIds: string[];
  canEdit: boolean;
  canAdmin: boolean;
};

function humanOnly(actor: Actor) {
  if (actor.kind !== "human" || actor.system) throw new ServiceError("forbidden", "Only teammates work with projects");
}

async function notGuest(q: Q, actor: Actor) {
  const role = await workspaceRoleOf(q, actor.workspaceId, actor.id);
  if (!role || role === "guest") throw new ServiceError("not_found", "Project not found");
}

/**
 * Open a project for a person: they must be on a team that takes part (a guest never is, and a project of another workspace, a
 * deleted one and one they cannot see all answer not_found). Editing needs the project lead, or an editor or admin of the lead team;
 * "admin" (the lead, the lead team, deleting) needs the project lead or an admin of the lead team.
 */
export async function openProject(q: Q, actor: Actor, id: string, need: "read" | "edit" | "admin" = "read"): Promise<Access> {
  humanOnly(actor);
  const notFound = () => new ServiceError("not_found", "Project not found");
  if (!isUuid(id)) throw notFound();
  await notGuest(q, actor);
  const [project] = await q.select().from(projects).where(and(eq(projects.id, id), eq(projects.workspaceId, actor.workspaceId), isNull(projects.deletedAt)));
  if (!project) throw notFound();
  const teamIds = (await q.select({ id: projectTeams.teamId }).from(projectTeams).where(eq(projectTeams.projectId, id))).map((r) => r.id);
  const roles = (await teamRoleMap(q, actor)) ?? new Map<string, TeamRole>();
  const mine = new Map(teamIds.flatMap((t) => (roles.has(t) ? [[t, roles.get(t)!] as const] : [])));
  if (!mine.size) throw notFound();
  const isLead = project.leadUserId === actor.id;
  const leadRole = mine.get(project.leadTeamId);
  const canEdit = isLead || (!!leadRole && roleAllows(leadRole, "edit"));
  const canAdmin = isLead || (!!leadRole && roleAllows(leadRole, "admin"));
  if (need === "edit" && !canEdit) throw new ServiceError("forbidden", "Only the project lead, or an editor of the lead team, can change a project");
  if (need === "admin" && !canAdmin) throw new ServiceError("forbidden", "Only the project lead, or an admin of the lead team, can do that");
  return { project, mine, teamIds, canEdit, canAdmin };
}

// ───────── events ─────────

export async function workspaceEvent(q: Q, actor: Actor, e: { type: string; entityId: string; summary: string; data?: Record<string, unknown>; entity?: "project" | "initiative" }) {
  await q.insert(workspaceEvents).values({
    workspaceId: actor.workspaceId,
    actorKind: actor.kind,
    actorId: actor.id,
    actorName: actor.name,
    type: e.type,
    entity: e.entity ?? "project",
    entityId: e.entityId,
    summary: e.summary,
    data: e.data ?? {},
  });
}

/** What matters to a team goes into that team's own log too, which is what its agents read. */
async function teamEvents(tx: Tx, actor: Actor, teamIds: string[], e: { type: string; entityId: string; summary: string; data?: Record<string, unknown> }) {
  for (const teamId of teamIds) await emit(tx, actor, teamId, { ...e, entity: "project" });
}

// ───────── reading ─────────

export type ProjectSummary = {
  id: string;
  name: string;
  description: string;
  status: ProjectStatus;
  priority: Priority;
  health: HealthView;
  startDate: string | null;
  targetDate: string | null;
  leadUser: { id: string; name: string; avatarUrl: string | null } | null;
  /** Named only for someone on the lead team: others are told nothing about teams they are not on. */
  leadTeam: { key: string; name: string } | null;
  /** Every issue in the project, across all the teams, and how many are done. */
  total: number;
  done: number;
  teamCount: number;
  version: number;
  canEdit: boolean;
  updatedAt: Date;
};

type Counts = Map<string, ProgressCounts>;

async function progressOf(q: Q, projectIds: string[]): Promise<Counts> {
  const out: Counts = new Map(projectIds.map((id) => [id, { total: 0, done: 0 }]));
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

async function summarise(q: Q, actor: Actor, rows: ProjectRow[], now: Date): Promise<ProjectSummary[]> {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const progress = await progressOf(q, ids);
  const roles = (await teamRoleMap(q, actor)) ?? new Map<string, TeamRole>();
  const leadIds = [...new Set(rows.map((r) => r.leadUserId).filter((x): x is string => !!x))];
  const lead = new Map((leadIds.length ? await q.select({ id: users.id, name: users.name, avatarKey: users.avatarKey }).from(users).where(inArray(users.id, leadIds)) : []).map((u) => [u.id, u]));
  const teamRows = await q.select({ id: teams.id, key: teams.key, name: teams.name }).from(teams).where(inArray(teams.id, [...new Set(rows.map((r) => r.leadTeamId))]));
  const teamById = new Map(teamRows.map((t) => [t.id, t]));
  const counts = await q.select({ projectId: projectTeams.projectId, n: sql<number>`count(*)::int` }).from(projectTeams).where(inArray(projectTeams.projectId, ids)).groupBy(projectTeams.projectId);
  const nTeams = new Map(counts.map((c) => [c.projectId, Number(c.n)]));
  return rows.map((p) => {
    const pr = progress.get(p.id)!;
    const leadRole = roles.get(p.leadTeamId);
    const t = leadRole ? teamById.get(p.leadTeamId) : undefined;
    return {
      id: p.id,
      name: p.name,
      description: p.description,
      status: p.status,
      priority: p.priority,
      health: healthOf(p, pr, now),
      startDate: p.startDate,
      targetDate: p.targetDate,
      leadUser: p.leadUserId && lead.has(p.leadUserId) ? { id: p.leadUserId, name: lead.get(p.leadUserId)!.name, avatarUrl: avatarUrl(p.leadUserId, lead.get(p.leadUserId)!.avatarKey) } : null,
      leadTeam: t ? { key: t.key, name: t.name } : null,
      total: pr.total,
      done: pr.done,
      teamCount: nTeams.get(p.id) ?? 0,
      version: p.version,
      canEdit: p.leadUserId === actor.id || (!!leadRole && roleAllows(leadRole, "edit")),
      updatedAt: p.updatedAt,
    };
  });
}

const STATUS_ORDER: Record<ProjectStatus, number> = { active: 0, planned: 1, paused: 2, completed: 3, canceled: 4 };

/** The projects the person can see (through `project_visibility`), active ones first. A guest sees none. */
export async function listProjects(actor: Actor, now = new Date()): Promise<ProjectSummary[]> {
  humanOnly(actor);
  const db = await getDb();
  const role = await workspaceRoleOf(db, actor.workspaceId, actor.id);
  if (!role || role === "guest") return [];
  const rows = await db
    .select({ p: projects })
    .from(projects)
    .innerJoin(projectVisibility, eq(projectVisibility.projectId, projects.id))
    .where(and(eq(projectVisibility.userId, actor.id), eq(projects.workspaceId, actor.workspaceId), isNull(projects.deletedAt)));
  const list = await summarise(db, actor, rows.map((r) => r.p), now);
  return list.sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.name.localeCompare(b.name));
}

export type ProjectMilestoneView = { id: string; name: string; description: string; targetDate: string | null; position: number; total: number; done: number };
export type ProjectIssueView = { ref: string; title: string; priority: string; status: string; done: boolean; milestoneId: string | null };
export type ProjectTeamView = { key: string; name: string; role: TeamRole; lead: boolean; total: number; done: number; issues: ProjectIssueView[] };
export type ProjectDetail = ProjectSummary & {
  canAdmin: boolean;
  milestones: ProjectMilestoneView[];
  /** The teams of the project the viewer is on, with their issues. */
  teams: ProjectTeamView[];
  /** The teams they are not on: how many, and the totals of their issues. Never a name or a title. */
  others: { count: number; total: number; done: number };
  /** Teams the viewer could bring in (they edit them) and that do not take part yet. */
  addableTeams: { key: string; name: string }[];
};

export async function getProject(actor: Actor, id: string, now = new Date()): Promise<ProjectDetail> {
  const db = await getDb();
  const a = await openProject(db, actor, id);
  const [summary] = await summarise(db, actor, [a.project], now);
  const perTeam = await db
    .select({ teamId: issues.teamId, total: sql<number>`count(*) filter (where ${statuses.role} is distinct from 'canceled')::int`, done: sql<number>`count(*) filter (where ${statuses.role} = 'done')::int` })
    .from(issues)
    .innerJoin(statuses, eq(statuses.id, issues.statusId))
    .where(eq(issues.projectId, id))
    .groupBy(issues.teamId);
  const counts = new Map(perTeam.map((r) => [r.teamId, { total: Number(r.total), done: Number(r.done) }]));
  const teamRows = await db.select({ id: teams.id, key: teams.key, name: teams.name }).from(teams).where(inArray(teams.id, a.teamIds));
  const mineRows = teamRows.filter((t) => a.mine.has(t.id)).sort((x, y) => x.key.localeCompare(y.key));
  const mineIds = mineRows.map((t) => t.id);
  const mineIssues = mineIds.length
    ? await db
        .select({ teamId: issues.teamId, number: issues.number, title: issues.title, priority: issues.priority, status: statuses.name, role: statuses.role, milestoneId: issues.milestoneId })
        .from(issues)
        .innerJoin(statuses, eq(statuses.id, issues.statusId))
        .where(and(eq(issues.projectId, id), inArray(issues.teamId, mineIds)))
        .orderBy(asc(issues.number))
    : [];
  const teamViews: ProjectTeamView[] = mineRows.map((t) => ({
    key: t.key,
    name: t.name,
    role: a.mine.get(t.id)!,
    lead: t.id === a.project.leadTeamId,
    total: counts.get(t.id)?.total ?? 0,
    done: counts.get(t.id)?.done ?? 0,
    issues: mineIssues.filter((x) => x.teamId === t.id).map((x) => ({ ref: `${t.key}-${x.number}`, title: x.title, priority: x.priority, status: x.status, done: x.role === "done", milestoneId: x.milestoneId })),
  }));
  const otherIds = a.teamIds.filter((t) => !a.mine.has(t));
  const others = otherIds.reduce((acc, t) => ({ count: acc.count + 1, total: acc.total + (counts.get(t)?.total ?? 0), done: acc.done + (counts.get(t)?.done ?? 0) }), { count: 0, total: 0, done: 0 });
  const msCounts = await db
    .select({ milestoneId: issues.milestoneId, total: sql<number>`count(*) filter (where ${statuses.role} is distinct from 'canceled')::int`, done: sql<number>`count(*) filter (where ${statuses.role} = 'done')::int` })
    .from(issues)
    .innerJoin(statuses, eq(statuses.id, issues.statusId))
    .where(and(eq(issues.projectId, id), sql`${issues.milestoneId} is not null`))
    .groupBy(issues.milestoneId);
  const byMs = new Map(msCounts.map((r) => [r.milestoneId, r]));
  const milestones = (await db.select().from(projectMilestones).where(eq(projectMilestones.projectId, id)).orderBy(asc(projectMilestones.position), asc(projectMilestones.createdAt))).map((m) => ({
    id: m.id,
    name: m.name,
    description: m.description,
    targetDate: m.targetDate,
    position: m.position,
    total: Number(byMs.get(m.id)?.total ?? 0),
    done: Number(byMs.get(m.id)?.done ?? 0),
  }));
  let addableTeams: { key: string; name: string }[] = [];
  if (a.canEdit) {
    const roles = (await teamRoleMap(db, actor)) ?? new Map<string, TeamRole>();
    const candidates = [...roles].filter(([tid, role]) => roleAllows(role, "edit") && !a.teamIds.includes(tid)).map(([tid]) => tid);
    if (candidates.length) addableTeams = (await db.select({ key: teams.key, name: teams.name }).from(teams).where(inArray(teams.id, candidates))).sort((x, y) => x.key.localeCompare(y.key));
  }
  return { ...summary, canAdmin: a.canAdmin, milestones, teams: teamViews, others, addableTeams };
}

// ───────── writing ─────────

export type ProjectInput = {
  name?: unknown;
  description?: unknown;
  status?: unknown;
  priority?: unknown;
  startDate?: unknown;
  targetDate?: unknown;
  /** The person who leads it (a member of the workspace, not a guest); null for nobody. */
  leadUser?: unknown;
  /** The key of the lead team: one of the teams taking part. */
  leadTeam?: unknown;
  /** `null` clears the health that was set by hand. */
  healthOverride?: unknown;
  /** When creating: the keys of the other teams taking part. */
  teams?: unknown;
  /** The version last read, for an update. */
  version?: unknown;
};

export const bad = (field: string, message: string): never => {
  throw new ServiceError("invalid", message, { fields: { [field]: message } });
};

export function text(v: unknown, field: string, max: number, required = false): string | undefined {
  if (v === undefined) return required ? bad(field, `${field} is required`) : undefined;
  if (typeof v !== "string") return bad(field, `${field} must be text`);
  const t = v.trim();
  if (required && !t) return bad(field, `${field} is required`);
  if (t.length > max) return bad(field, `${field} is at most ${max} characters`);
  return t;
}

export function day(v: unknown, field: string): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  if (typeof v !== "string" || !DATE_RE.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`)) || new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) !== v) return bad(field, `${field} must be a date like 2026-12-31`);
  return v;
}

export function oneOf<T extends string>(v: unknown, list: readonly T[], field: string): T | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "string" || !(list as readonly string[]).includes(v)) return bad(field, `${field} must be one of ${list.join(", ")}`);
  return v as T;
}

async function leadMember(q: Q, actor: Actor, v: unknown): Promise<string | null | undefined> {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  if (!isUuid(v)) return bad("leadUser", "leadUser must be a person's id");
  const [m] = await q.select({ role: memberships.role }).from(memberships).where(and(eq(memberships.workspaceId, actor.workspaceId), eq(memberships.userId, v)));
  if (!m || m.role === "guest") return bad("leadUser", "The lead must be a member of the workspace (not a guest)");
  return v;
}

async function lockProject(tx: Tx, id: string, expected?: unknown) {
  const [row] = await tx.select().from(projects).where(eq(projects.id, id)).for("update");
  if (typeof expected === "number" && row && expected !== row.version) throw new ServiceError("conflict", `The project was changed (version ${row.version}, you had ${expected}). Re-read and retry.`, { current: row });
  return row;
}

export async function createProject(actor: Actor, input: ProjectInput, now = new Date()): Promise<ProjectDetail> {
  humanOnly(actor);
  const db = await getDb();
  await notGuest(db, actor);
  const name = text(input.name, "name", 120, true)!;
  const description = text(input.description, "description", 20_000) ?? "";
  const status = oneOf(input.status, schema.PROJECT_STATUSES, "status") ?? "planned";
  const priority = oneOf(input.priority, schema.PRIORITIES, "priority") ?? "none";
  const startDate = day(input.startDate, "startDate") ?? null;
  const targetDate = day(input.targetDate, "targetDate") ?? null;
  if (startDate && targetDate && targetDate < startDate) bad("targetDate", "The target date is before the start date");
  const healthOverride = oneOf(input.healthOverride, schema.PROJECT_HEALTH, "healthOverride") ?? null;
  if (typeof input.leadTeam !== "string" || !input.leadTeam) bad("leadTeam", "Choose the lead team");
  const lead = await requireTeam(actor, input.leadTeam as string, "edit", db);
  const others = Array.isArray(input.teams) ? input.teams : input.teams === undefined ? [] : bad("teams", "teams must be a list of team keys");
  const extra: Awaited<ReturnType<typeof requireTeam>>[] = [];
  for (const k of others as unknown[]) {
    if (typeof k !== "string") bad("teams", "teams must be a list of team keys");
    const t = await requireTeam(actor, k as string, "edit", db);
    if (t.id !== lead.id && !extra.some((x) => x.id === t.id)) extra.push(t);
  }
  const leadUser = (await leadMember(db, actor, input.leadUser)) ?? actor.id;
  const created = await db.transaction(async (tx) => {
    const [p] = await tx.insert(projects).values({ workspaceId: actor.workspaceId, name, description, status, priority, startDate, targetDate, healthOverride, leadUserId: leadUser, leadTeamId: lead.id }).returning();
    await tx.insert(projectTeams).values([lead, ...extra].map((t) => ({ projectId: p.id, teamId: t.id, workspaceId: actor.workspaceId })));
    await workspaceEvent(tx, actor, { type: "project.created", entityId: p.id, summary: `created project "${p.name}"`, data: { lead: lead.key, teams: [lead, ...extra].map((t) => t.key) } });
    await teamEvents(tx, actor, [lead, ...extra].map((t) => t.id), { type: "project.created", entityId: p.id, summary: `took part in new project "${p.name}"`, data: { name: p.name } });
    return p;
  });
  return getProject(actor, created.id, now);
}

export async function updateProject(actor: Actor, id: string, patch: ProjectInput, now = new Date()): Promise<ProjectDetail> {
  const db = await getDb();
  const wantsLead = patch.leadUser !== undefined || patch.leadTeam !== undefined;
  await openProject(db, actor, id, wantsLead ? "admin" : "edit");
  const name = text(patch.name, "name", 120, patch.name !== undefined);
  const description = text(patch.description, "description", 20_000);
  const status = oneOf(patch.status, schema.PROJECT_STATUSES, "status");
  const priority = oneOf(patch.priority, schema.PRIORITIES, "priority");
  const startDate = day(patch.startDate, "startDate");
  const targetDate = day(patch.targetDate, "targetDate");
  const healthOverride = patch.healthOverride === null ? null : oneOf(patch.healthOverride, schema.PROJECT_HEALTH, "healthOverride");
  const leadUser = await leadMember(db, actor, patch.leadUser);
  await db.transaction(async (tx) => {
    const cur = await lockProject(tx, id, patch.version);
    const set: Partial<typeof projects.$inferInsert> = {};
    if (name !== undefined && name !== cur.name) set.name = name;
    if (description !== undefined && description !== cur.description) set.description = description;
    if (status !== undefined && status !== cur.status) set.status = status;
    if (priority !== undefined && priority !== cur.priority) set.priority = priority;
    if (startDate !== undefined && startDate !== cur.startDate) set.startDate = startDate;
    if (targetDate !== undefined && targetDate !== cur.targetDate) set.targetDate = targetDate;
    if (healthOverride !== undefined && healthOverride !== cur.healthOverride) set.healthOverride = healthOverride;
    if (leadUser !== undefined && leadUser !== cur.leadUserId) set.leadUserId = leadUser;
    if (patch.leadTeam !== undefined) {
      if (typeof patch.leadTeam !== "string") bad("leadTeam", "leadTeam must be a team key");
      const [t] = await tx.select({ id: teams.id, name: teams.name }).from(teams).where(and(eq(teams.workspaceId, actor.workspaceId), sql`lower(${teams.key}) = lower(${patch.leadTeam as string})`));
      const [takes] = t ? await tx.select().from(projectTeams).where(and(eq(projectTeams.projectId, id), eq(projectTeams.teamId, t.id))) : [];
      if (!t || !takes) bad("leadTeam", "The lead team must be one of the teams taking part");
      if (t.id !== cur.leadTeamId) set.leadTeamId = t.id;
    }
    const sd = set.startDate === undefined ? cur.startDate : set.startDate;
    const td = set.targetDate === undefined ? cur.targetDate : set.targetDate;
    if (sd && td && td < sd) bad("targetDate", "The target date is before the start date");
    if (!Object.keys(set).length) return;
    const [u] = await tx.update(projects).set({ ...set, version: cur.version + 1, updatedAt: new Date() }).where(eq(projects.id, id)).returning();
    const changed = Object.keys(set);
    await workspaceEvent(tx, actor, { type: "project.updated", entityId: id, summary: `updated project "${u.name}": ${changed.join(", ")}`, data: { changed, from: Object.fromEntries(changed.map((k) => [k, (cur as Record<string, unknown>)[k]])), to: Object.fromEntries(changed.map((k) => [k, (u as Record<string, unknown>)[k]])) } });
    if (set.status || set.targetDate !== undefined) {
      const ids = (await tx.select({ id: projectTeams.teamId }).from(projectTeams).where(eq(projectTeams.projectId, id))).map((r) => r.id);
      await teamEvents(tx, actor, ids, { type: "project.status_changed", entityId: id, summary: `project "${u.name}" ${set.status ? `is now ${u.status}` : "has a new target date"}`, data: { name: u.name, status: u.status, targetDate: u.targetDate } });
    }
  });
  return getProject(actor, id, now);
}

/** Delete a project (soft). Its issues stay on their boards, in no project and no milestone. */
export async function deleteProject(actor: Actor, id: string) {
  const db = await getDb();
  await openProject(db, actor, id, "admin");
  return db.transaction(async (tx) => {
    const cur = await lockProject(tx, id);
    const released = await tx.update(issues).set({ projectId: null, milestoneId: null, version: sql`${issues.version} + 1`, updatedAt: new Date() }).where(eq(issues.projectId, id)).returning({ id: issues.id });
    await tx.update(projects).set({ deletedAt: new Date(), version: cur.version + 1, updatedAt: new Date() }).where(eq(projects.id, id));
    const ids = (await tx.select({ id: projectTeams.teamId }).from(projectTeams).where(eq(projectTeams.projectId, id))).map((r) => r.id);
    await workspaceEvent(tx, actor, { type: "project.deleted", entityId: id, summary: `deleted project "${cur.name}"${released.length ? ` (${released.length} issue${released.length === 1 ? "" : "s"} left it)` : ""}`, data: { name: cur.name, released: released.length } });
    await teamEvents(tx, actor, ids, { type: "project.deleted", entityId: id, summary: `project "${cur.name}" was deleted`, data: { name: cur.name } });
    return { ok: true, released: released.length };
  });
}

// ───────── teams ─────────

/** Bring a team in. The person needs to be able to change the project and to edit the team they bring (nobody is pulled in). */
export async function addProjectTeam(actor: Actor, id: string, teamKey: unknown) {
  const db = await getDb();
  await openProject(db, actor, id, "edit");
  if (typeof teamKey !== "string" || !teamKey) bad("team", "Choose a team");
  const team = await requireTeam(actor, teamKey as string, "edit", db);
  await db.transaction(async (tx) => {
    const cur = await lockProject(tx, id);
    const [already] = await tx.select().from(projectTeams).where(and(eq(projectTeams.projectId, id), eq(projectTeams.teamId, team.id)));
    if (already) throw new ServiceError("conflict", `${team.name} already takes part`);
    await tx.insert(projectTeams).values({ projectId: id, teamId: team.id, workspaceId: actor.workspaceId });
    await tx.update(projects).set({ version: cur.version + 1, updatedAt: new Date() }).where(eq(projects.id, id));
    await workspaceEvent(tx, actor, { type: "project.team_added", entityId: id, summary: `${team.key} joined project "${cur.name}"`, data: { team: team.key } });
    await teamEvents(tx, actor, [team.id], { type: "project.team_added", entityId: id, summary: `joined project "${cur.name}"`, data: { name: cur.name } });
  });
  return getProject(actor, id);
}

/**
 * Take a team out. The project's editors can, and so can an admin of that team (a team may leave). The lead team cannot go until
 * another is made lead. A team with issues in the project is refused with their number, unless `releaseIssues` says they
 * leave the project with it.
 */
export async function removeProjectTeam(actor: Actor, id: string, teamKey: string, o: { releaseIssues?: boolean } = {}) {
  const db = await getDb();
  const a = await openProject(db, actor, id, "read");
  const team = (await db.select().from(teams).where(and(eq(teams.workspaceId, actor.workspaceId), sql`lower(${teams.key}) = lower(${teamKey})`)))[0];
  if (!team || !a.teamIds.includes(team.id)) throw new ServiceError("not_found", `Team ${teamKey} does not take part in this project`);
  const roles = (await teamRoleMap(db, actor)) ?? new Map<string, TeamRole>();
  const mayLeave = roles.get(team.id) === "admin";
  if (!a.canEdit && !mayLeave) throw new ServiceError("forbidden", "Only the project lead, an editor of the lead team, or an admin of that team can take it out");
  if (team.id === a.project.leadTeamId) throw new ServiceError("conflict", "That is the lead team. Make another team the lead first.");
  return db.transaction(async (tx) => {
    const cur = await lockProject(tx, id);
    const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(issues).where(and(eq(issues.projectId, id), eq(issues.teamId, team.id)));
    if (Number(n) > 0 && !o.releaseIssues) throw new ServiceError("conflict", `${team.name} has ${n} issue${Number(n) === 1 ? "" : "s"} in this project. Release them with the team, or move them out first.`, { issues: Number(n) });
    if (Number(n) > 0) await tx.update(issues).set({ projectId: null, milestoneId: null, version: sql`${issues.version} + 1`, updatedAt: new Date() }).where(and(eq(issues.projectId, id), eq(issues.teamId, team.id)));
    await tx.delete(projectTeams).where(and(eq(projectTeams.projectId, id), eq(projectTeams.teamId, team.id)));
    await tx.update(projects).set({ version: cur.version + 1, updatedAt: new Date() }).where(eq(projects.id, id));
    await workspaceEvent(tx, actor, { type: "project.team_removed", entityId: id, summary: `${team.key} left project "${cur.name}"${Number(n) ? ` (${n} issue${Number(n) === 1 ? "" : "s"} left with it)` : ""}`, data: { team: team.key, released: Number(n) } });
    await teamEvents(tx, actor, [team.id], { type: "project.team_removed", entityId: id, summary: `left project "${cur.name}"`, data: { name: cur.name, released: Number(n) } });
    return { ok: true, released: Number(n) };
  });
}

// ───────── milestones ─────────

export type MilestoneInput = { name?: unknown; description?: unknown; targetDate?: unknown; index?: unknown };

async function milestoneTeams(q: Q, id: string) {
  return (await q.select({ id: projectTeams.teamId }).from(projectTeams).where(eq(projectTeams.projectId, id))).map((r) => r.id);
}

export async function createMilestone(actor: Actor, id: string, input: MilestoneInput) {
  const db = await getDb();
  await openProject(db, actor, id, "edit");
  const name = text(input.name, "name", 120, true)!;
  const description = text(input.description, "description", 5_000) ?? "";
  const targetDate = day(input.targetDate, "targetDate") ?? null;
  await db.transaction(async (tx) => {
    const cur = await lockProject(tx, id);
    const [{ max }] = await tx.select({ max: sql<number>`coalesce(max(${projectMilestones.position}), 0)` }).from(projectMilestones).where(eq(projectMilestones.projectId, id));
    const [m] = await tx.insert(projectMilestones).values({ projectId: id, workspaceId: actor.workspaceId, name, description, targetDate, position: Number(max) + 1000 }).returning();
    await tx.update(projects).set({ updatedAt: new Date() }).where(eq(projects.id, id));
    await workspaceEvent(tx, actor, { type: "project.milestone_changed", entityId: id, summary: `added milestone "${m.name}" to project "${cur.name}"`, data: { milestone: m.id, change: "added", name: m.name } });
    await teamEvents(tx, actor, await milestoneTeams(tx, id), { type: "project.milestone_changed", entityId: id, summary: `project "${cur.name}" has a new milestone "${m.name}"`, data: { milestone: m.id, change: "added", name: m.name } });
  });
  return getProject(actor, id);
}

export async function updateMilestone(actor: Actor, id: string, milestoneId: string, patch: MilestoneInput) {
  const db = await getDb();
  await openProject(db, actor, id, "edit");
  const name = text(patch.name, "name", 120, patch.name !== undefined);
  const description = text(patch.description, "description", 5_000);
  const targetDate = day(patch.targetDate, "targetDate");
  if (patch.index !== undefined && (typeof patch.index !== "number" || !Number.isSafeInteger(patch.index) || patch.index < 0)) bad("index", "index must be a position from 0");
  await db.transaction(async (tx) => {
    const cur = await lockProject(tx, id);
    const [m] = isUuid(milestoneId) ? await tx.select().from(projectMilestones).where(and(eq(projectMilestones.id, milestoneId), eq(projectMilestones.projectId, id))) : [];
    if (!m) throw new ServiceError("not_found", "Milestone not found");
    const set: Partial<typeof projectMilestones.$inferInsert> = {};
    if (name !== undefined && name !== m.name) set.name = name;
    if (description !== undefined && description !== m.description) set.description = description;
    if (targetDate !== undefined && targetDate !== m.targetDate) set.targetDate = targetDate;
    if (typeof patch.index === "number") {
      const sibs = await tx.select({ id: projectMilestones.id, position: projectMilestones.position }).from(projectMilestones).where(and(eq(projectMilestones.projectId, id))).orderBy(asc(projectMilestones.position));
      const others = sibs.filter((s) => s.id !== m.id);
      const i = Math.min(patch.index, others.length);
      const before = others[i - 1]?.position;
      const after = others[i]?.position;
      const position = before === undefined && after === undefined ? 1000 : before === undefined ? after! - 1000 : after === undefined ? before + 1000 : (before + after) / 2;
      if (position !== m.position) set.position = position;
    }
    if (!Object.keys(set).length) return;
    await tx.update(projectMilestones).set(set).where(eq(projectMilestones.id, m.id));
    await tx.update(projects).set({ updatedAt: new Date() }).where(eq(projects.id, id));
    const changed = Object.keys(set);
    await workspaceEvent(tx, actor, { type: "project.milestone_changed", entityId: id, summary: `changed milestone "${m.name}" of project "${cur.name}": ${changed.join(", ")}`, data: { milestone: m.id, change: "updated", changed } });
    await teamEvents(tx, actor, await milestoneTeams(tx, id), { type: "project.milestone_changed", entityId: id, summary: `milestone "${m.name}" of project "${cur.name}" changed: ${changed.join(", ")}`, data: { milestone: m.id, change: "updated", changed } });
  });
  return getProject(actor, id);
}

export async function deleteMilestone(actor: Actor, id: string, milestoneId: string) {
  const db = await getDb();
  await openProject(db, actor, id, "edit");
  await db.transaction(async (tx) => {
    const cur = await lockProject(tx, id);
    const [m] = isUuid(milestoneId) ? await tx.select().from(projectMilestones).where(and(eq(projectMilestones.id, milestoneId), eq(projectMilestones.projectId, id))) : [];
    if (!m) throw new ServiceError("not_found", "Milestone not found");
    await tx.delete(projectMilestones).where(eq(projectMilestones.id, m.id));
    await tx.update(projects).set({ updatedAt: new Date() }).where(eq(projects.id, id));
    await workspaceEvent(tx, actor, { type: "project.milestone_changed", entityId: id, summary: `removed milestone "${m.name}" from project "${cur.name}"`, data: { milestone: m.id, change: "removed", name: m.name } });
    await teamEvents(tx, actor, await milestoneTeams(tx, id), { type: "project.milestone_changed", entityId: id, summary: `project "${cur.name}" lost its milestone "${m.name}"`, data: { milestone: m.id, change: "removed", name: m.name } });
  });
  return getProject(actor, id);
}

// ───────── an issue's project ─────────

export type IssueProjectChoice = { projectId: string | null; milestoneId: string | null };

/**
 * What an issue's `project` and `milestone` mean for its team. The project must be live in the workspace and the team must take
 * part (the database refuses the rest); a milestone must be the project's. Changing the project drops the milestone unless one of
 * the new project is named, and a milestone alone keeps the project the issue is in.
 */
export async function resolveIssueProject(
  q: Q,
  team: { id: string; name: string; workspaceId: string },
  current: IssueProjectChoice,
  want: { project?: string | null; milestone?: string | null },
): Promise<IssueProjectChoice> {
  let projectId = want.project === undefined ? current.projectId : want.project;
  const milestoneId = want.milestone === undefined ? (projectId === current.projectId ? current.milestoneId : null) : want.milestone;
  if (projectId !== null) {
    if (!isUuid(projectId)) bad("projectId", "projectId must be a project id, or null for none");
    const [p] = await q.select({ id: projects.id, name: projects.name }).from(projects).where(and(eq(projects.id, projectId), eq(projects.workspaceId, team.workspaceId), isNull(projects.deletedAt)));
    if (!p) bad("projectId", "That project does not exist");
    const [takes] = await q.select().from(projectTeams).where(and(eq(projectTeams.projectId, projectId), eq(projectTeams.teamId, team.id)));
    if (!takes) bad("projectId", `${team.name} does not take part in "${p.name}". Ask the project's lead to bring the team in first.`);
  } else {
    if (milestoneId !== null) bad("milestoneId", "A milestone needs a project");
    projectId = null;
  }
  if (milestoneId !== null) {
    if (!isUuid(milestoneId)) bad("milestoneId", "milestoneId must be a milestone id, or null for none");
    const [m] = await q.select({ id: projectMilestones.id }).from(projectMilestones).where(and(eq(projectMilestones.id, milestoneId), eq(projectMilestones.projectId, projectId!)));
    if (!m) bad("milestoneId", "That milestone is not in this issue's project");
  }
  return { projectId, milestoneId };
}

/** The projects a team takes part in, with their milestones, for the board's chips and the issue's Project field. */
export type TeamProjectOption = { id: string; name: string; status: ProjectStatus; milestones: { id: string; name: string }[] };
export async function projectsOfTeam(q: Q, teamId: string): Promise<TeamProjectOption[]> {
  const rows = await q
    .select({ id: projects.id, name: projects.name, status: projects.status })
    .from(projectTeams)
    .innerJoin(projects, eq(projects.id, projectTeams.projectId))
    .where(and(eq(projectTeams.teamId, teamId), isNull(projects.deletedAt)))
    .orderBy(asc(projects.name));
  if (!rows.length) return [];
  const ms = await q
    .select({ id: projectMilestones.id, projectId: projectMilestones.projectId, name: projectMilestones.name })
    .from(projectMilestones)
    .where(inArray(projectMilestones.projectId, rows.map((r) => r.id)))
    .orderBy(asc(projectMilestones.position));
  return rows.map((r) => ({ ...r, milestones: ms.filter((m) => m.projectId === r.id).map(({ id, name }) => ({ id, name })) }));
}
