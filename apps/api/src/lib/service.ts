import { statusForRole, DEFAULT_STATUS_DEFS, roleFromText } from "@wheelhouse/shared/status-roles";
import { and, asc, desc, eq, gt, inArray, isNull, lt, lte, ne, or, sql } from "drizzle-orm";
import { getDb, schema, type DB } from "../db";
import type { Actor } from "./access";
import { bucketOf, REMOVED_KEEP_MS, SESSION_IDLE_LIMIT_MS } from "@wheelhouse/shared/session-buckets";
import { bus, deferPublish } from "./event-bus";
import { checklistStatus, type ChecklistState } from "./setup-checklist";
import { getDocTemplate, listDocTemplates as listDocTemplatesStatic } from "@wheelhouse/shared/doc-templates";
import { parseTeamIcon, parseTeamIconColor } from "./team-icon";
import { ServiceError } from "./service-error";
import { deleteBlock, resolveParent } from "./team-lifecycle";
import { cleanLabels, labelsOf, setDecisionNodes, setIssueLabels, withCycle, withLabels, withNodeIds } from "./links";
import { assertWritable, audit, lockWorkspaceTeams, type Need, roleAllows, roleOnTeam, visibleTeamIds, workspaceRoleOf } from "./team-access";

export { ServiceError };

/**
 * The single write path for Wheelhouse. UI server actions, the REST API and the
 * MCP server all call into here, so every mutation is workspace-scoped, versioned
 * where it matters, and recorded in `events` (the activity feed + AI queue).
 */

const { teams, statuses, issues, comments, nodes, edges, issueNodes, events, agentCursors, flows, decisions, terms, workSessions, repositories, docs, docNodes, apiKeys, users, projects } = schema;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (s: string) => UUID_RE.test(s);

export const DEFAULT_STATUSES = DEFAULT_STATUS_DEFS.map((c) => c.name);

export type Tx = Parameters<Parameters<DB["transaction"]>[0]>[0];
export type Q = DB | Tx;

/**
 * Lock a row for the rest of the transaction and read it as it is NOW. A version check that reads, compares and writes is only
 * safe if two edits from the same version cannot both read it before either writes; on Postgres (not on the single-connection
 * embedded database the tests use) they can. The second one waits here for the first to commit, then sees its version.
 */
async function lockRow<T extends { id: string }>(tx: Tx, table: typeof issues | typeof nodes | typeof docs, row: T): Promise<T> {
  const [fresh] = await tx.select().from(table).where(eq(table.id, row.id)).for("update");
  return (fresh as unknown as T | undefined) ?? row;
}

export async function emit(
  q: Q,
  actor: Actor,
  teamId: string,
  e: { type: string; entity: (typeof events.$inferInsert)["entity"]; entityId: string; summary: string; data?: Record<string, unknown> },
) {
  const [row] = await q
    .insert(events)
    .values({
      workspaceId: actor.workspaceId,
      teamId,
      actorKind: actor.kind,
      actorId: actor.id,
      actorName: actor.name,
      type: e.type,
      entity: e.entity,
      entityId: e.entityId,
      summary: e.summary,
      data: e.data ?? {},
      sessionId: actor.kind === "agent" ? (actor.sessionId ?? null) : null,
    })
    .returning({ seq: events.seq });
  // Tell open browser streams (WH-1). Inside a transaction this waits for the commit, so a watcher never re-reads old data.
  deferPublish(q, {
    workspaceId: actor.workspaceId,
    teamId,
    seq: row.seq,
    type: e.type,
    entity: e.entity,
    entityId: e.entityId,
    actorKind: actor.kind,
    actorName: actor.name,
    summary: e.summary,
  });
}

/** Shallow diff for event payloads: { field: { from, to } } */
function diff<T extends Record<string, unknown>>(before: T, patch: Partial<T>) {
  const out: Record<string, { from: unknown; to: unknown }> = {};
  for (const k of Object.keys(patch)) {
    const a = before[k];
    const b = patch[k as keyof T];
    if (b !== undefined && JSON.stringify(a) !== JSON.stringify(b)) out[k] = { from: a, to: b };
  }
  return out;
}

// ───────────────────────── teams ─────────────────────────

/** The teams the actor can open: a person's own teams, or the teams an agent key is scoped to (ADR-23, WH-120). */
export async function listTeams(actor: Actor, opts: { includeRetired?: boolean } = {}) {
  const db = await getDb();
  const visible = await visibleTeamIds(db, actor);
  if (visible && !visible.length) return [];
  return db
    .select()
    .from(teams)
    .where(and(eq(teams.workspaceId, actor.workspaceId), visible ? inArray(teams.id, visible) : undefined, opts.includeRetired ? undefined : isNull(teams.retiredAt)))
    .orderBy(asc(teams.createdAt));
}

/** Finds a team of the actor's workspace by uuid or key, WITHOUT checking that the actor may open it. Only access code uses this. */
export async function findWorkspaceTeam(actor: Actor, ref: string, q?: Q) {
  const db = q ?? (await getDb());
  const [p] = await db
    .select()
    .from(teams)
    .where(
      and(
        eq(teams.workspaceId, actor.workspaceId),
        isUuid(ref) ? eq(teams.id, ref) : eq(sql`upper(${teams.key})`, ref.toUpperCase()),
      ),
    );
  return p;
}

/**
 * Accepts a team uuid or its key (e.g. "WH"). A team of another workspace and a team the actor is not a member of both
 * answer not_found, so its existence does not leak; a member whose role is too low for `need` gets forbidden (ADR-23).
 */
export async function requireTeam(actor: Actor, ref: string, need: Need = "read", q?: Q) {
  const db = q ?? (await getDb());
  const p = await findWorkspaceTeam(actor, ref, db);
  const role = p ? await roleOnTeam(db, actor, p.id) : null;
  if (!p || !role) throw new ServiceError("not_found", `Team ${ref} not found`);
  if (!roleAllows(role, need)) throw new ServiceError("forbidden", need === "admin" ? "Only a team admin can do that" : "Your role on this team is read only");
  // The one check behind every write path: a retired team can be read, never changed (WH-128).
  if (need === "edit") assertWritable(p);
  return p;
}

/** Rename a team and/or change its description. Team admins only; the key never changes (issues are named after it). */
export async function updateTeam(actor: Actor, ref: string, input: { name?: string; description?: string; icon?: unknown; iconColor?: unknown }) {
  if (actor.kind !== "human") throw new ServiceError("forbidden", "Only teammates can edit a team's settings");
  const db = await getDb();
  const p = await requireTeam(actor, ref, "admin", db);
  const name = input.name === undefined ? p.name : input.name.trim();
  if (!name) throw new ServiceError("invalid", "Team name is required");
  const description = input.description === undefined ? p.description : input.description.trim();
  const icon = parseTeamIcon(input.icon);
  const iconColor = parseTeamIconColor(input.iconColor);
  const next = { name, description, icon: icon === undefined ? p.icon : icon, iconColor: iconColor === undefined ? p.iconColor : iconColor };
  if (next.name === p.name && next.description === p.description && next.icon === p.icon && next.iconColor === p.iconColor) return p;
  return db.transaction(async (tx) => {
    const [row] = await tx.update(teams).set(next).where(eq(teams.id, p.id)).returning();
    await audit(tx, actor, { action: "team.updated", targetType: "team", targetId: p.id, teamId: p.id, before: { name: p.name, icon: p.icon, iconColor: p.iconColor }, after: { name, icon: next.icon, iconColor: next.iconColor } });
    await emit(tx, actor, p.id, { type: "team.updated", entity: "team", entityId: p.id, summary: `updated the settings of team ${row.name}` });
    return row;
  });
}

/** Delete a team and everything in it (issues, map, flows, drafts, sessions, activity). Teammates only. */
export async function deleteTeam(actor: Actor, ref: string) {
  if (actor.kind !== "human") throw new ServiceError("forbidden", "Only teammates can delete a team");
  const db = await getDb();
  const found = await requireTeam(actor, ref, "admin");
  const p = await db.transaction(async (tx) => {
    // Lock the workspace's teams, then count: two admins deleting the last two teams at once cannot both succeed.
    await lockWorkspaceTeams(tx, found.workspaceId);
    const [p] = await tx.select().from(teams).where(eq(teams.id, found.id));
    if (!p) throw new ServiceError("not_found", `Team ${ref} not found`);
    // The last active team stays, a team that leads a live project waits until someone else leads it, and child teams go or move first.
    const why = await deleteBlock(tx, actor, p);
    if (why) throw new ServiceError("conflict", why);
    // A deleted project the team led goes for good with it.
    const led = await tx.select({ id: projects.id }).from(projects).where(eq(projects.leadTeamId, p.id));
    if (led.length) await tx.delete(projects).where(inArray(projects.id, led.map((x) => x.id)));
    await audit(tx, actor, { action: "team.deleted", targetType: "team", targetId: p.id, teamId: p.id, before: { key: p.key, name: p.name, retired: !!p.retiredAt } });
    // events has no foreign key to teams, so clear it explicitly; everything else cascades.
    await tx.delete(events).where(eq(events.teamId, p.id));
    await tx.delete(teams).where(eq(teams.id, p.id));
    return p;
  });
  return { ok: true, deleted: p.key };
}

export async function createTeam(actor: Actor, input: { name: string; key?: string; description?: string; parent?: string | null }) {
  const db = await getDb();
  const name = input.name.trim();
  if (!name) throw new ServiceError("invalid", "Team name is required");
  // Workspace Viewers and Guests cannot start teams (ADR-23); agent keys can still create them.
  if (actor.kind === "human") {
    const ws = await workspaceRoleOf(db, actor.workspaceId, actor.id);
    if (ws !== "owner" && ws !== "admin" && ws !== "member") throw new ServiceError("forbidden", "Your workspace role cannot create teams");
  }
  const key = (input.key || name.replace(/[^a-zA-Z]/g, "").slice(0, 3) || "PRJ").toUpperCase().slice(0, 6);
  const existing = await db
    .select({ id: teams.id })
    .from(teams)
    .where(and(eq(teams.workspaceId, actor.workspaceId), eq(teams.key, key)));
  if (existing.length) throw new ServiceError("conflict", `Team key ${key} already in use`);

  return db.transaction(async (tx) => {
    // A parent must be a team of this workspace that the creator can open; it grants nothing in either direction.
    const parent = input.parent ? await resolveParent(tx, actor, null, input.parent) : null;
    const [p] = await tx
      .insert(teams)
      .values({ workspaceId: actor.workspaceId, name, key, description: input.description ?? "", parentId: parent?.id ?? null })
      .returning();
    await tx.insert(statuses).values(DEFAULT_STATUS_DEFS.map((c, i) => ({ teamId: p.id, workspaceId: p.workspaceId, name: c.name, role: c.role, isDefault: true, position: i + 1 })));
    // The creator becomes the team's first admin: without a row here nobody could open the team they just made.
    if (actor.kind === "human") {
      await tx.insert(schema.teamMembers).values({ teamId: p.id, userId: actor.id, workspaceId: actor.workspaceId, role: "admin", addedBy: actor.id });
      await audit(tx, actor, { action: "team.created", targetType: "team", targetId: p.id, teamId: p.id, after: { key: p.key, creatorRole: "admin", ...(parent ? { parentKey: parent.key } : {}) } });
    } else if (!actor.system) {
      // A key that makes a team is scoped to it, or it could not open what it just made (WH-120).
      await tx.insert(schema.apiKeyTeams).values({ apiKeyId: actor.id, teamId: p.id, workspaceId: p.workspaceId });
    }
    await emit(tx, actor, p.id, { type: "team.created", entity: "team", entityId: p.id, summary: `created team ${p.name}` });
    return p;
  });
}

// ───────────────────────── board / issues ─────────────────────────

export type IssueWithLinks = typeof issues.$inferSelect & { ref: string; labels: string[]; cycle: number | null; nodeIds: string[]; commentCount: number };

const CLAIM_TTL_MS = 24 * 3600e3;

/**
 * Release agent claims with no activity from the claiming agent for a day, so a
 * crashed or abandoned session doesn't hold work hostage. Logged as an event.
 */
export async function expireStaleClaims(teamId: string) {
  const db = await getDb();
  const claimed = await db
    .select()
    .from(issues)
    .where(and(eq(issues.teamId, teamId), sql`${issues.claimedByKeyId} is not null`));
  for (const t of claimed) {
    const [last] = await db
      .select({ at: events.createdAt })
      .from(events)
      .where(and(eq(events.entityId, t.id), eq(events.actorId, t.claimedByKeyId!)))
      .orderBy(desc(events.seq))
      .limit(1);
    const lastAt = new Date(last?.at ?? t.updatedAt).getTime();
    if (Date.now() - lastAt < CLAIM_TTL_MS) continue;
    const [p] = await db.select().from(teams).where(eq(teams.id, teamId));
    await db.transaction(async (tx) => {
      await tx.update(issues).set({ claimedByKeyId: null, version: t.version + 1, updatedAt: new Date() }).where(eq(issues.id, t.id));
      await tx.insert(events).values({
        workspaceId: p.workspaceId,
        teamId,
        actorKind: "human",
        actorId: null,
        actorName: "Wheelhouse",
        type: "issue.claim_expired",
        entity: "issue",
        entityId: t.id,
        summary: `released ${p.key}-${t.number}: no activity from the claiming agent for 24h`,
        data: { ref: `${p.key}-${t.number}` },
      });
    });
  }
}

export async function getBoard(actor: Actor, teamRef: string) {
  const db = await getDb();
  const team = await requireTeam(actor, teamRef);
  await expireStaleClaims(team.id);
  await (await import("./cycles")).rolloverCycles(team.id);
  const cols = await db.select().from(statuses).where(eq(statuses.teamId, team.id)).orderBy(asc(statuses.position));
  const ts = await db.select().from(issues).where(eq(issues.teamId, team.id)).orderBy(asc(issues.position));
  const ids = ts.map((t) => t.id);
  const links = ids.length ? await db.select().from(issueNodes).where(inArray(issueNodes.issueId, ids)) : [];
  const labelMap = await labelsOf(db, ids);
  const cycleOf = new Map((await withCycle(db, ts)).map((t) => [t.id, t.cycle]));
  const counts = ids.length
    ? await db
        .select({ issueId: comments.issueId, n: sql<number>`count(*)::int` })
        .from(comments)
        .where(inArray(comments.issueId, ids))
        .groupBy(comments.issueId)
    : [];
  const countMap = new Map(counts.map((c) => [c.issueId, Number(c.n)]));
  const withLinks: IssueWithLinks[] = ts.map((t) => ({
    ...t,
    ref: `${team.key}-${t.number}`,
    labels: labelMap.get(t.id) ?? [],
    cycle: cycleOf.get(t.id) ?? null,
    nodeIds: links.filter((l) => l.issueId === t.id).map((l) => l.nodeId),
    commentCount: countMap.get(t.id) ?? 0,
  }));
  return { team, statuses: cols, issues: withLinks };
}

/** An assignee must be a member of the issue's team: a user from another workspace, a workspace member who is not on the team, or a made-up id is refused. */
async function assertAssignee(q: Q, teamId: string, userId: string | null | undefined) {
  if (!userId) return;
  const [m] = isUuid(userId)
    ? await q
        .select({ userId: schema.teamMembers.userId })
        .from(schema.teamMembers)
        .where(and(eq(schema.teamMembers.teamId, teamId), eq(schema.teamMembers.userId, userId)))
    : [];
  if (!m) throw new ServiceError("invalid", "Assignee must be a member of this team");
}

async function resolveStatus(q: Q, teamId: string, ref: string) {
  const cols = await q.select().from(statuses).where(eq(statuses.teamId, teamId)).orderBy(asc(statuses.position));
  // An id or an exact name wins; otherwise a role ("review") finds the status with that role even if it was renamed.
  const role = roleFromText(ref);
  const c = cols.find((c) => c.id === ref) ?? cols.find((c) => c.name.toLowerCase() === ref.toLowerCase()) ?? (role ? statusForRole(cols, role) : undefined);
  if (!c) throw new ServiceError("invalid", `Unknown status "${ref}". Valid: ${cols.map((c) => c.name).join(", ")}`);
  return c;
}

/** Accepts an issue uuid or a ref like "WH-12". An issue of a team the actor cannot open is not_found; `need` says what the caller will do with it. */
export async function resolveIssue(actor: Actor, ref: string, q?: Q, need: Need = "read") {
  const db = q ?? (await getDb());
  let row: { t: typeof issues.$inferSelect; p: typeof teams.$inferSelect } | undefined;
  if (isUuid(ref)) {
    [row] = await db
      .select({ t: issues, p: teams })
      .from(issues)
      .innerJoin(teams, eq(teams.id, issues.teamId))
      .where(and(eq(issues.id, ref), eq(teams.workspaceId, actor.workspaceId)));
  } else {
    const m = /^([A-Za-z]+)-(\d+)$/.exec(ref.trim());
    if (!m) throw new ServiceError("invalid", `Bad issue ref "${ref}" (use uuid or KEY-123)`);
    [row] = await db
      .select({ t: issues, p: teams })
      .from(issues)
      .innerJoin(teams, eq(teams.id, issues.teamId))
      .where(
        and(eq(teams.workspaceId, actor.workspaceId), eq(teams.key, m[1].toUpperCase()), eq(issues.number, Number(m[2]))),
      );
  }
  const role = row ? await roleOnTeam(db, actor, row.p.id) : null;
  if (!row || !role) throw new ServiceError("not_found", `Issue ${ref} not found`);
  if (!roleAllows(role, need)) throw new ServiceError("forbidden", "Your role on this team is read only");
  if (need === "edit") assertWritable(row.p);
  return { issue: row.t, team: row.p, ref: `${row.p.key}-${row.t.number}` };
}

export async function getIssue(actor: Actor, ref: string) {
  const db = await getDb();
  const { issue, team, ref: r } = await resolveIssue(actor, ref);
  const [col] = await db.select().from(statuses).where(eq(statuses.id, issue.statusId));
  const cs = await db.select().from(comments).where(eq(comments.issueId, issue.id)).orderBy(asc(comments.createdAt));
  const linked = await db
    .select({ id: nodes.id, name: nodes.name, kind: nodes.kind, parentId: nodes.parentId })
    .from(issueNodes)
    .innerJoin(nodes, eq(nodes.id, issueNodes.nodeId))
    .where(eq(issueNodes.issueId, issue.id));
  const history = await db
    .select()
    .from(events)
    .where(and(eq(events.teamId, team.id), eq(events.entityId, issue.id)))
    .orderBy(desc(events.seq))
    .limit(50);
  // Pull requests GitHub reported against this issue (WH-20). Loaded lazily: that module imports this one.
  const { pullRequestsForIssue } = await import("./github/service");
  const pullRequests = await pullRequestsForIssue(issue.id);
  const [withLabel] = await withCycle(db, await withLabels(db, [issue]));
  const { parent, children } = await (await import("./sub-issues")).relatives(db, team, issue);
  return { issue: { ...withLabel, ref: r, status: col?.name }, team, comments: cs, nodes: linked, history, pullRequests, parent, children };
}

async function positionAt(q: Q, statusId: string, index: number | undefined, excludeId?: string) {
  const siblings = await q
    .select({ id: issues.id, position: issues.position })
    .from(issues)
    .where(and(eq(issues.statusId, statusId), excludeId ? ne(issues.id, excludeId) : undefined))
    .orderBy(asc(issues.position));
  const i = index === undefined || index < 0 || index > siblings.length ? siblings.length : index;
  const before = siblings[i - 1]?.position;
  const after = siblings[i]?.position;
  if (before === undefined && after === undefined) return 1000;
  if (before === undefined) return after! - 1000;
  if (after === undefined) return before + 1000;
  return (before + after) / 2;
}

export type IssueInput = {
  title?: string;
  body?: string;
  priority?: (typeof schema.PRIORITIES)[number];
  assigneeId?: string | null;
  agentClaimable?: boolean;
  labels?: string[];
  /** The number of one of the issue's own team's cycles that has not ended; null takes it out of its cycle. */
  cycle?: number | null;
  /**
   * The id of a project the issue's team takes part in; null takes the issue out of its project (and its milestone). Named
   * `projectId`, not `project`: the tools pass their own `project` argument (the team) through this same object.
   */
  projectId?: string | null;
  /** The id of a milestone of the issue's project; null clears it. Changing the project clears it unless a new one is named. */
  milestoneId?: string | null;
  /** The issue this one is a sub-issue of: a ref ("WH-12") or id of an issue in the same team; null makes it a top-level issue. */
  parent?: string | null;
};

/** The issue joined or left a project: said to the issue's team, whose agents read that log. */
async function emitProjectMove(tx: Tx, actor: Actor, teamId: string, ref: string, from: string | null, to: string | null) {
  if (from === to) return;
  const ids = [from, to].filter((x): x is string => !!x);
  const names = new Map((await tx.select({ id: projects.id, name: projects.name }).from(projects).where(inArray(projects.id, ids))).map((p) => [p.id, p.name]));
  if (from) await emit(tx, actor, teamId, { type: "project.issue_left", entity: "project", entityId: from, summary: `${ref} left project "${names.get(from) ?? ""}"`, data: { ref, project: names.get(from) ?? null } });
  if (to) await emit(tx, actor, teamId, { type: "project.issue_joined", entity: "project", entityId: to, summary: `${ref} joined project "${names.get(to) ?? ""}"`, data: { ref, project: names.get(to) ?? null } });
}

export async function createIssue(actor: Actor, teamRef: string, input: IssueInput & { title: string; status?: string }) {
  const db = await getDb();
  const team = await requireTeam(actor, teamRef, "edit");
  if (!input.title?.trim()) throw new ServiceError("invalid", "title is required");
  return db.transaction(async (tx) => {
    await assertAssignee(tx, team.id, input.assigneeId);
    const cycle = input.cycle == null ? null : await (await import("./cycles")).cycleForIssue(tx, team.id, input.cycle);
    const inProject =
      input.projectId === undefined && input.milestoneId === undefined
        ? { projectId: null, milestoneId: null }
        : await (await import("./projects")).resolveIssueProject(tx, team, { projectId: null, milestoneId: null }, { project: input.projectId, milestone: input.milestoneId });
    const parentId = input.parent == null ? null : await (await import("./sub-issues")).resolveParent(tx, team, null, input.parent);
    const col = await resolveStatus(tx, team.id, input.status ?? DEFAULT_STATUSES[0]);
    const [{ issueCounter }] = await tx
      .update(teams)
      .set({ issueCounter: sql`${teams.issueCounter} + 1` })
      .where(eq(teams.id, team.id))
      .returning({ issueCounter: teams.issueCounter });
    const position = await positionAt(tx, col.id, undefined);
    const [t] = await tx
      .insert(issues)
      .values({
        teamId: team.id,
        workspaceId: team.workspaceId,
        statusId: col.id,
        number: issueCounter,
        title: input.title.trim(),
        body: input.body ?? "",
        priority: input.priority ?? "none",
        assigneeId: input.assigneeId ?? null,
        cycleId: cycle?.id ?? null,
        projectId: inProject.projectId,
        milestoneId: inProject.milestoneId,
        parentId,
        agentClaimable: input.agentClaimable ?? actor.kind === "agent",
        position,
        createdByKind: actor.kind,
        createdById: actor.id,
      })
      .returning();
    await setIssueLabels(tx, team, t.id, input.labels ?? []);
    const ref = `${team.key}-${t.number}`;
    await emitProjectMove(tx, actor, team.id, ref, null, t.projectId);
    await emit(tx, actor, team.id, {
      type: "issue.created",
      entity: "issue",
      entityId: t.id,
      summary: `created ${ref} "${t.title}" in ${col.name}`,
      data: { ref, status: col.name, title: t.title, ...(parentId ? { parent: input.parent } : {}) },
    });
    const [withLabel] = await withCycle(tx, await withLabels(tx, [t]));
    return { ...withLabel, ref, status: col.name };
  });
}

/**
 * Patch an issue. Pass `expectedVersion` for optimistic locking: if someone
 * (human or agent) changed the issue since you read it, you get a 409 with
 * the current state instead of silently overwriting their change.
 */
export async function updateIssue(actor: Actor, ref: string, patch: IssueInput, expectedVersion?: number) {
  return bindSession(actor, await updateIssueTx(actor, ref, patch, expectedVersion));
}

async function updateIssueTx(actor: Actor, ref: string, patch: IssueInput, expectedVersion?: number) {
  const db = await getDb();
  return db.transaction(async (tx) => {
    const resolved = await resolveIssue(actor, ref, tx, "edit");
    const { team, ref: r } = resolved;
    const locked = await lockRow(tx, issues, resolved.issue);
    const [issue] = await withCycle(tx, await withLabels(tx, [locked]));
    if (expectedVersion !== undefined && expectedVersion !== issue.version) {
      throw new ServiceError("conflict", `${r} was changed (version ${issue.version}, you had ${expectedVersion}). Re-read and retry.`, {
        current: issue,
      });
    }
    const clean: IssueInput = {};
    for (const [k, v] of Object.entries(patch)) if (v !== undefined) (clean as Record<string, unknown>)[k] = v;
    if (clean.labels) {
      // Labels are stored once per name in any case and read back alphabetically, so a different order or case is no change.
      const want = cleanLabels(clean.labels);
      const key = (xs: string[]) => xs.map((x) => x.toLowerCase()).sort().join("\u0000");
      if (key(want) === key(issue.labels)) delete clean.labels;
      else clean.labels = want;
    }
    await assertAssignee(tx, team.id, clean.assigneeId);
    const { projectId: wantProject, milestoneId: wantMilestone, parent: wantParent, ...cleanRest } = clean;
    const parentChange = wantParent === undefined ? {} : { parentId: await (await import("./sub-issues")).resolveParent(tx, team, issue.id, wantParent) };
    const projectChoice =
      wantProject === undefined && wantMilestone === undefined
        ? undefined
        : await (await import("./projects")).resolveIssueProject(tx, team, { projectId: issue.projectId, milestoneId: issue.milestoneId }, { project: wantProject, milestone: wantMilestone });
    const changes = diff(issue as unknown as Record<string, unknown>, { ...cleanRest, ...(projectChoice ?? {}), ...parentChange } as Record<string, unknown>);
    if (!Object.keys(changes).length) return { ...issue, ref: r };
    const { labels: newLabels, cycle: newCycle, ...columnsPatch } = cleanRest;
    const cycleChange = newCycle === undefined ? {} : { cycleId: newCycle === null ? null : (await (await import("./cycles")).cycleForIssue(tx, team.id, newCycle)).id };
    const [row] = await tx
      .update(issues)
      .set({ ...columnsPatch, ...cycleChange, ...(projectChoice ?? {}), ...parentChange, version: issue.version + 1, updatedAt: new Date() })
      .where(eq(issues.id, issue.id))
      .returning();
    if (newLabels) await setIssueLabels(tx, team, row.id, newLabels);
    const t = { ...row, labels: newLabels ?? issue.labels, cycle: newCycle === undefined ? issue.cycle : newCycle };
    await emitProjectMove(tx, actor, team.id, r, issue.projectId, row.projectId);
    await emit(tx, actor, team.id, {
      type: "issue.updated",
      entity: "issue",
      entityId: t.id,
      summary: `updated ${r}: ${Object.keys(changes).join(", ")}`,
      data: { ref: r, changes },
    });
    return { ...t, ref: r };
  });
}

export async function moveIssue(actor: Actor, ref: string, status: string, index?: number, expectedVersion?: number) {
  return bindSession(actor, await moveIssueTx(actor, ref, status, index, expectedVersion));
}

async function moveIssueTx(actor: Actor, ref: string, status: string, index?: number, expectedVersion?: number) {
  const db = await getDb();
  return db.transaction(async (tx) => {
    const resolved = await resolveIssue(actor, ref, tx, "edit");
    const { team, ref: r } = resolved;
    const locked = await lockRow(tx, issues, resolved.issue);
    const [issue] = await withCycle(tx, await withLabels(tx, [locked]));
    if (expectedVersion !== undefined && expectedVersion !== issue.version) {
      throw new ServiceError("conflict", `${r} was changed since you read it`, { current: issue });
    }
    const to = await resolveStatus(tx, team.id, status);
    const [from] = await tx.select().from(statuses).where(eq(statuses.id, issue.statusId));
    const position = await positionAt(tx, to.id, index, issue.id);
    const [moved] = await tx
      .update(issues)
      .set({ statusId: to.id, position, version: issue.version + 1, updatedAt: new Date() })
      .where(eq(issues.id, issue.id))
      .returning();
    const t = { ...moved, labels: issue.labels, cycle: issue.cycle };
    if (from.id !== to.id) {
      await emit(tx, actor, team.id, {
        type: "issue.moved",
        entity: "issue",
        entityId: t.id,
        summary: `moved ${r} from ${from.name} → ${to.name}`,
        data: { ref: r, from: from.name, to: to.name, fromRole: from.role, toRole: to.role },
      });
    }
    return { ...t, ref: r, status: to.name };
  });
}

export async function deleteIssue(actor: Actor, ref: string) {
  const db = await getDb();
  return db.transaction(async (tx) => {
    const { issue, team, ref: r } = await resolveIssue(actor, ref, tx, "edit");
    await tx.delete(issues).where(eq(issues.id, issue.id));
    await emit(tx, actor, team.id, {
      type: "issue.deleted",
      entity: "issue",
      entityId: issue.id,
      summary: `deleted ${r} "${issue.title}"`,
      data: { ref: r, title: issue.title },
    });
    return { ok: true };
  });
}

/** Agent claims an issue it's about to work on (only if humans marked it claimable). */
export async function claimIssue(actor: Actor, ref: string) {
  if (actor.kind !== "agent") throw new ServiceError("forbidden", "Only agents claim issues");
  const db = await getDb();
  const t = await db.transaction(async (tx) => {
    const { issue, team, ref: r } = await resolveIssue(actor, ref, tx, "edit");
    if (!issue.agentClaimable) throw new ServiceError("forbidden", `${r} is not marked agent-claimable by the workspace`);
    if (issue.claimedByKeyId && issue.claimedByKeyId !== actor.id)
      throw new ServiceError("conflict", `${r} is already claimed by another agent`);
    const [claimed] = await tx
      .update(issues)
      .set({ claimedByKeyId: actor.id, version: issue.version + 1, updatedAt: new Date() })
      .where(eq(issues.id, issue.id))
      .returning();
    const [t] = await withCycle(tx, await withLabels(tx, [claimed]));
    await emit(tx, actor, team.id, { type: "issue.claimed", entity: "issue", entityId: t.id, summary: `claimed ${r}`, data: { ref: r } });
    return { ...t, ref: r };
  });
  return bindSession(actor, t);
}

/** An agent working an issue binds it to its active session (for the reconciliation check). */
async function bindSession<T extends { id: string; teamId: string }>(actor: Actor, t: T): Promise<T> {
  if (actor.kind === "agent") {
    const { noteIssueActivity } = await import("./sync");
    await noteIssueActivity(actor, t.teamId, t.id);
  }
  return t;
}

export async function addComment(actor: Actor, ref: string, body: string) {
  if (!body?.trim()) throw new ServiceError("invalid", "Comment body is required");
  const db = await getDb();
  const { c, issue } = await db.transaction(async (tx) => {
    const { issue, team, ref: r } = await resolveIssue(actor, ref, tx, "edit");
    const [c] = await tx
      .insert(comments)
      .values({ issueId: issue.id, authorKind: actor.kind, authorId: actor.id, authorName: actor.name, body: body.trim() })
      .returning();
    await emit(tx, actor, team.id, {
      type: "comment.created",
      entity: "issue",
      entityId: issue.id,
      summary: `commented on ${r}`,
      data: { ref: r, commentId: c.id, body: c.body },
    });
    return { c, issue };
  });
  await bindSession(actor, issue);
  return c;
}

// ───────────────────────── knowledge map ─────────────────────────
//
// One linked model at three zoom levels (concept → system → code). `depends`
// edges connect nodes within a level; `implements` edges connect a lower level
// to the higher-level thing it realizes. Flows, decisions and the glossary hang
// off nodes. Anchors + reported file changes keep the explanations honest.

export type NodeRow = typeof nodes.$inferSelect;
type Layer = schema.Layer;

const LAYER_RANK: Record<Layer, number> = { concept: 0, system: 1, data: 2, code: 3 };

export async function getGraph(actor: Actor, teamRef: string) {
  const db = await getDb();
  const team = await requireTeam(actor, teamRef);
  const ns = await db.select().from(nodes).where(eq(nodes.teamId, team.id));
  const es = await db.select().from(edges).where(eq(edges.teamId, team.id));
  const nodeIds = ns.map((n) => n.id);
  const links = nodeIds.length
    ? await db
        .select({ nodeId: issueNodes.nodeId, issueId: issues.id, number: issues.number, title: issues.title, statusId: issues.statusId })
        .from(issueNodes)
        .innerJoin(issues, eq(issues.id, issueNodes.issueId))
        .where(inArray(issueNodes.nodeId, nodeIds))
    : [];
  const fl = await db.select().from(flows).where(eq(flows.teamId, team.id)).orderBy(asc(flows.name));
  const ds = await db.select().from(decisions).where(eq(decisions.teamId, team.id)).orderBy(asc(decisions.number));
  const ts = await db.select().from(terms).where(eq(terms.teamId, team.id)).orderBy(asc(terms.term));
  const alive = new Set(nodeIds);
  return {
    team,
    nodes: ns,
    edges: es,
    issueLinks: links.map((l) => ({ ...l, ref: `${team.key}-${l.number}` })),
    flows: fl.map((f) => ({ ...f, steps: f.steps.filter((s) => alive.has(s.nodeId)) })),
    decisions: (await withNodeIds(db, ds)).map((d) => ({ ...d, nodeIds: d.nodeIds.filter((id) => alive.has(id)) })),
    terms: ts,
    // Nodes whose files are being changed in active sessions, and pending drafts.
    flux: await (await import("./sync")).fluxForTeam(team.id),
  };
}

/**
 * Resolve a node by uuid or name (case-insensitive). Names may repeat across
 * layers ("Billing" concept vs "billing" service), so pass `layer` or use the
 * "layer:name" form to disambiguate.
 */
export async function resolveNode(q: Q, teamId: string, ref: string, layer?: Layer) {
  let name = ref.trim();
  const m = /^(concept|system|data|code):(.+)$/i.exec(name);
  if (m) {
    layer = m[1].toLowerCase() as Layer;
    name = m[2].trim();
  }
  const rows = await q
    .select()
    .from(nodes)
    .where(
      and(
        eq(nodes.teamId, teamId),
        isUuid(name) ? eq(nodes.id, name) : eq(sql`lower(${nodes.name})`, name.toLowerCase()),
        layer && !isUuid(name) ? eq(nodes.layer, layer) : undefined,
      ),
    );
  if (!rows.length) throw new ServiceError("not_found", `Node "${ref}" not found`);
  if (rows.length > 1)
    throw new ServiceError(
      "invalid",
      `"${ref}" is ambiguous (${rows.map((r) => `${r.layer}:${r.name}`).join(", ")}). Prefix with the layer, e.g. "${rows[0].layer}:${rows[0].name}".`,
    );
  return rows[0];
}

/** Everything about one node: explainer, neighbours on every layer, flows, decisions, issues. */
export async function getNode(actor: Actor, teamRef: string, ref: string) {
  const g = await getGraph(actor, teamRef);
  const db = await getDb();
  const n = await resolveNode(db, g.team.id, ref);
  const byId = new Map(g.nodes.map((x) => [x.id, x]));
  const brief = (x: NodeRow | undefined) => x && { id: x.id, name: x.name, layer: x.layer, kind: x.kind, summary: x.summary, stale: x.stale };
  const out = g.edges.filter((e) => e.fromNodeId === n.id);
  const inc = g.edges.filter((e) => e.toNodeId === n.id);
  return {
    node: n,
    parent: brief(n.parentId ? byId.get(n.parentId) : undefined) ?? null,
    children: g.nodes.filter((c) => c.parentId === n.id).map(brief),
    dependsOn: out.filter((e) => e.kind === "depends").map((e) => ({ ...brief(byId.get(e.toNodeId)), label: e.label })),
    usedBy: inc.filter((e) => e.kind === "depends").map((e) => ({ ...brief(byId.get(e.fromNodeId)), label: e.label })),
    implements: out.filter((e) => e.kind === "implements").map((e) => brief(byId.get(e.toNodeId))),
    implementedBy: inc.filter((e) => e.kind === "implements").map((e) => brief(byId.get(e.fromNodeId))),
    flows: g.flows
      .filter((f) => f.steps.some((s) => s.nodeId === n.id))
      .map((f) => ({ id: f.id, name: f.name, step: f.steps.findIndex((s) => s.nodeId === n.id) + 1 })),
    decisions: g.decisions
      .filter((d) => d.nodeIds.includes(n.id))
      .map((d) => ({ number: d.number, title: d.title, status: d.status })),
    issues: g.issueLinks.filter((l) => l.nodeId === n.id).map((l) => ({ ref: l.ref, title: l.title })),
  };
}

export type NodeInput = {
  id?: string; // update when given (uuid or name)
  name?: string;
  layer?: Layer;
  kind?: (typeof schema.NODE_KINDS)[number];
  parent?: string | null; // parent node uuid or name (same layer); null = top level
  summary?: string;
  purpose?: string;
  responsibilities?: string;
  interfaces?: string;
  gotchas?: string;
  details?: string;
  status?: "planned" | "building" | "live" | "deprecated";
  anchors?: string[];
  describedSha?: string;
  markFresh?: boolean;
  implements?: string[]; // higher-layer nodes this one realizes
  columns?: schema.Column[]; // data layer only
  indexes?: schema.Index[]; // data layer only
  forcePublish?: boolean; // skip the in-flux draft check (landing, human publish)
  /** Optimistic lock: the node version the caller last read. A different current version is a 409 and nothing changes. The web app sends it; agents' tools do not. */
  expectedVersion?: number;
  describedHashes?: Record<string, string>; // content hashes the explanation was written against
  x?: number;
  y?: number;
};

const EXPLAINER_FIELDS = ["summary", "purpose", "responsibilities", "interfaces", "gotchas", "details"] as const;

function defaultKind(layer: Layer, hasParent: boolean): (typeof schema.NODE_KINDS)[number] {
  if (layer === "concept") return hasParent ? "capability" : "concept";
  if (layer === "code") return hasParent ? "file" : "directory";
  if (layer === "data") return "table";
  return hasParent ? "module" : "service";
}

function checkKind(layer: Layer, kind: string) {
  const allowed = schema.KINDS_BY_LAYER[layer] as readonly string[];
  if (!allowed.includes(kind))
    throw new ServiceError("invalid", `kind "${kind}" isn't valid on the ${layer} layer (use: ${allowed.join(", ")})`);
}

/** Create or update a map node. Agents use names, the UI uses ids. */
export async function upsertNode(actor: Actor, teamRef: string, input: NodeInput) {
  const db = await getDb();
  const team = await requireTeam(actor, teamRef, "edit");

  // An agent describing code its own session hasn't landed yet: store a draft
  // instead of rewriting the shared map (published when the code lands).
  if (actor.kind === "agent" && !input.forcePublish && (input.id || input.name)) {
    const ref = input.id ?? input.name!;
    const found = await resolveNode(db, team.id, ref, input.layer).catch(() => undefined);
    if (found) {
      const { maybeDraft } = await import("./sync");
      const d = await maybeDraft(actor, found, input);
      if (d) return { ...found, ...d };
    }
  }

  const result = await db.transaction(async (tx) => {
    let existing: NodeRow | undefined;
    if (input.id) existing = await resolveNode(tx, team.id, input.id, input.layer);
    else if (input.name) {
      const rows = await tx
        .select()
        .from(nodes)
        .where(
          and(
            eq(nodes.teamId, team.id),
            eq(sql`lower(${nodes.name})`, input.name.trim().toLowerCase()),
            input.layer ? eq(nodes.layer, input.layer) : undefined,
          ),
        );
      if (rows.length > 1) throw new ServiceError("invalid", `"${input.name}" exists on several layers; pass layer`);
      existing = rows[0];
    }

    if (existing) existing = await lockRow(tx, nodes, existing);
    if (existing && input.expectedVersion !== undefined && input.expectedVersion !== existing.version) {
      throw new ServiceError("conflict", `"${existing.name}" was changed (version ${existing.version}, you had ${input.expectedVersion}). Re-read and retry.`, { current: existing });
    }
    const layer: Layer = existing?.layer ?? input.layer ?? "system";
    if (existing && input.layer && input.layer !== existing.layer)
      throw new ServiceError("invalid", `Can't move "${existing.name}" between layers; create a new node and link it with implements`);

    let parentId: string | null | undefined = undefined;
    if (input.parent === null) parentId = null;
    else if (input.parent) {
      const p = await resolveNode(tx, team.id, input.parent, layer);
      if (p.layer !== layer) throw new ServiceError("invalid", `Parent must be on the same layer (${layer})`);
      parentId = p.id;
    }
    if (input.kind) checkKind(layer, input.kind);
    if ((input.columns || input.indexes) && layer !== "data")
      throw new ServiceError("invalid", "columns/indexes only apply to data-layer nodes (tables, views, enums)");
    const columns = input.columns?.map(cleanColumn);

    if (existing) {
      if (parentId === existing.id) throw new ServiceError("invalid", "A node cannot be its own parent");
      const reparented = parentId !== undefined && parentId !== existing.parentId;
      const patch = {
        name: input.name?.trim(),
        kind: input.kind,
        parentId,
        summary: input.summary,
        purpose: input.purpose,
        responsibilities: input.responsibilities,
        interfaces: input.interfaces,
        gotchas: input.gotchas,
        details: input.details,
        status: input.status,
        anchors: input.anchors,
        columns,
        indexes: input.indexes,
        // Positions are relative to the parent, so reset when the container changes.
        x: input.x ?? (reparented ? 20 : undefined),
        y: input.y ?? (reparented ? 60 : undefined),
        width: reparented ? null : undefined,
        height: reparented ? null : undefined,
        // An explicit x/y from the caller counts as a person placing it; a reparent resets
        // to the fixed offset above, which is grid-placement again, not a deliberate position.
        placed: input.x !== undefined && input.y !== undefined && !reparented ? true : reparented ? false : undefined,
      };
      const changes = diff(existing as unknown as Record<string, unknown>, patch as Record<string, unknown>);
      const described =
        EXPLAINER_FIELDS.some((f) => f in changes) || "anchors" in changes || "columns" in changes || "indexes" in changes || input.markFresh || input.describedSha;
      const fresh = described
        ? {
            stale: false,
            staleReason: null,
            staleSource: null,
            driftPaths: [],
            describedHashes: input.describedHashes ?? (await landedHashesFor(tx, team.id, input.anchors ?? existing.anchors)),
            describedAt: new Date(),
            describedSha: input.describedSha ?? existing.describedSha,
          }
        : {};
      if (!Object.keys(changes).length && !described) return { node: existing, created: false };
      const [n] = await tx
        .update(nodes)
        .set({
          ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)),
          ...fresh,
          version: existing.version + 1,
          updatedAt: new Date(),
        })
        .where(eq(nodes.id, existing.id))
        .returning();
      const meaningful = Object.keys(changes).filter((k) => !["x", "y", "width", "height"].includes(k));
      if (meaningful.length || (existing.stale && described)) {
        await emit(tx, actor, team.id, {
          type: "node.updated",
          entity: "node",
          entityId: n.id,
          summary: `updated ${n.layer} ${n.kind} "${n.name}"${meaningful.length ? `: ${meaningful.join(", ")}` : ""}${existing.stale && described ? " (now fresh)" : ""}`,
          data: { name: n.name, layer: n.layer, fields: meaningful },
        });
      }
      return { node: n, created: false, schemaChanged: "columns" in changes || "name" in changes };
    }

    if (!input.name?.trim()) throw new ServiceError("invalid", "name is required to create a node");
    // Auto-place new nodes so agent-created maps are readable without coordinates.
    let { x, y } = input;
    if (x === undefined || y === undefined) {
      const siblings = await tx
        .select({ id: nodes.id })
        .from(nodes)
        .where(
          and(
            eq(nodes.teamId, team.id),
            eq(nodes.layer, layer),
            parentId ? eq(nodes.parentId, parentId) : sql`${nodes.parentId} is null`,
          ),
        );
      const i = siblings.length;
      if (layer === "data" && !parentId) {
        // ERD cards vary in height: stack into 4 columns by accumulated height.
        const placed = await tx
          .select({ x: nodes.x, y: nodes.y, columns: nodes.columns })
          .from(nodes)
          .where(and(eq(nodes.teamId, team.id), eq(nodes.layer, "data")));
        const col = i % 4;
        const inCol = placed.filter((p) => Math.round((p.x - 50) / 320) === col);
        x = 50 + col * 320;
        y = inCol.reduce((m, p) => Math.max(m, p.y + tableHeight(p.columns.length) + 40), 50);
      } else {
        x = parentId ? 20 + (i % 2) * 210 : 50 + (i % 4) * 480;
        y = parentId ? 70 + Math.floor(i / 2) * 100 : 50 + Math.floor(i / 4) * 420;
      }
    }
    const kind = input.kind ?? defaultKind(layer, !!parentId);
    const [n] = await tx
      .insert(nodes)
      .values({
        teamId: team.id,
        workspaceId: team.workspaceId,
        parentId: parentId ?? null,
        layer,
        kind,
        name: input.name.trim(),
        summary: input.summary ?? "",
        purpose: input.purpose ?? "",
        responsibilities: input.responsibilities ?? "",
        interfaces: input.interfaces ?? "",
        gotchas: input.gotchas ?? "",
        details: input.details ?? "",
        status: input.status ?? "planned",
        anchors: input.anchors ?? [],
        columns: columns ?? [],
        indexes: input.indexes ?? [],
        describedHashes: input.describedHashes ?? (await landedHashesFor(tx, team.id, input.anchors ?? [])),
        describedSha: input.describedSha ?? null,
        describedAt: new Date(),
        x,
        y,
      })
      .returning();
    await emit(tx, actor, team.id, {
      type: "node.created",
      entity: "node",
      entityId: n.id,
      summary: `added ${n.layer} ${n.kind} "${n.name}"${parentId ? " (nested)" : ""}`,
      data: { name: n.name, layer: n.layer, kind: n.kind, parentId: n.parentId },
    });
    return { node: n, created: true, schemaChanged: n.layer === "data" };
  });

  for (const target of input.implements ?? []) {
    await upsertEdge(actor, team.id, { from: result.node.id, to: target, kind: "implements" });
  }
  if (result.schemaChanged) await syncReferences(actor, team.id);
  return result.node;
}

/** Landed content hashes for files matching these anchors: the baseline an explanation is written against. */
async function landedHashesFor(q: Q, teamId: string, anchors: string[]) {
  if (!anchors.length) return {};
  const files = await q.select({ path: schema.teamFiles.path, hash: schema.teamFiles.hash }).from(schema.teamFiles).where(eq(schema.teamFiles.teamId, teamId));
  return Object.fromEntries(files.filter((f) => anchors.some((a) => anchorScore(a, f.path) > 0)).map((f) => [f.path, f.hash]));
}

// ───────── data layer ─────────

/** Rendered height of an ERD card, shared with the canvas so auto-placement doesn't overlap. */
export const tableHeight = (columns: number) => 48 + Math.max(1, columns) * 22;

function cleanColumn(c: schema.Column): schema.Column {
  if (!c.name?.trim()) throw new ServiceError("invalid", "Every column needs a name");
  const out: schema.Column = { name: c.name.trim(), type: (c.type ?? "").trim() };
  if (c.nullable) out.nullable = true;
  if (c.pk) out.pk = true;
  if (c.unique) out.unique = true;
  if (c.default) out.default = c.default;
  if (c.references?.trim()) {
    if (!/^[^.\s]+\.[^.\s]+$/.test(c.references.trim()))
      throw new ServiceError("invalid", `Column "${c.name}": references must look like "table.column"`);
    out.references = c.references.trim();
  }
  if (c.onDelete) out.onDelete = c.onDelete;
  if (c.note) out.note = c.note;
  return out;
}

/**
 * Derive "references" edges from columns' `references: "table.column"`.
 * Columns are the single source of truth: edges are added, updated and removed
 * to match. Returns FK targets that don't exist on the map yet.
 */
export async function syncReferences(actor: Actor, teamRef: string) {
  const db = await getDb();
  const team = await requireTeam(actor, teamRef, "edit");
  const tables = await db.select().from(nodes).where(and(eq(nodes.teamId, team.id), eq(nodes.layer, "data")));
  const byName = new Map(tables.map((t) => [t.name.toLowerCase(), t]));
  const current = (await db.select().from(edges).where(and(eq(edges.teamId, team.id), eq(edges.kind, "references")))).filter(
    (e) => e.meta?.derived,
  );
  const key = (from: string, col: string) => `${from}:${col.toLowerCase()}`;
  const want = new Map<string, { from: NodeRow; to: NodeRow; meta: schema.EdgeMeta }>();
  const unresolved: string[] = [];
  for (const t of tables) {
    for (const c of t.columns) {
      if (!c.references) continue;
      const [tn, cn] = c.references.split(".");
      const target = byName.get(tn.toLowerCase());
      if (!target) {
        unresolved.push(`${t.name}.${c.name} → ${c.references}`);
        continue;
      }
      want.set(key(t.id, c.name), {
        from: t,
        to: target,
        meta: {
          derived: true,
          fromColumn: c.name,
          toColumn: cn,
          // One-to-one only when the FK column alone is unique: a sole PK or a unique column.
          // Part of a composite PK (e.g. a join table) is still many-to-one.
          cardinality: c.unique || (c.pk && t.columns.filter((x) => x.pk).length === 1) ? "1-1" : "n-1",
          ...(c.onDelete ? { onDelete: c.onDelete } : {}),
        },
      });
    }
  }
  let changed = 0;
  await db.transaction(async (tx) => {
    for (const e of current) {
      const w = want.get(key(e.fromNodeId, e.meta.fromColumn ?? ""));
      if (!w || w.to.id !== e.toNodeId) {
        await tx.delete(edges).where(eq(edges.id, e.id));
        changed++;
        continue;
      }
      if (JSON.stringify(w.meta) !== JSON.stringify(e.meta)) {
        await tx.update(edges).set({ meta: w.meta, label: `${w.meta.fromColumn} → ${w.meta.toColumn}` }).where(eq(edges.id, e.id));
        changed++;
      }
      want.delete(key(e.fromNodeId, e.meta.fromColumn ?? ""));
    }
    for (const w of want.values()) {
      await tx.insert(edges).values({
        teamId: team.id,
        workspaceId: team.workspaceId,
        fromNodeId: w.from.id,
        toNodeId: w.to.id,
        kind: "references",
        label: `${w.meta.fromColumn} → ${w.meta.toColumn}`,
        meta: w.meta,
      });
      changed++;
    }
    if (changed) {
      await emit(tx, actor, team.id, {
        type: "schema.relationships",
        entity: "team",
        entityId: team.id,
        summary: `updated ${changed} table relationship${changed === 1 ? "" : "s"}`,
        data: { changed },
      });
    }
  });
  return { changed, unresolved };
}

/** Compact data-layer view for agents: tables, columns, relationships. */
export async function getSchema(actor: Actor, teamRef: string) {
  const g = await getGraph(actor, teamRef);
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const tables = g.nodes.filter((n) => n.layer === "data").sort((a, b) => a.name.localeCompare(b.name));
  return {
    tables: tables.map((t) => ({
      name: t.name,
      kind: t.kind,
      summary: t.summary || undefined,
      columns: t.columns,
      indexes: t.indexes.length ? t.indexes : undefined,
      anchors: t.anchors.length ? t.anchors : undefined,
      stale: t.stale || undefined,
      implements: g.edges
        .filter((e) => e.kind === "implements" && e.fromNodeId === t.id)
        .map((e) => `${byId.get(e.toNodeId)?.layer}:${byId.get(e.toNodeId)?.name}`),
    })),
    relationships: g.edges
      .filter((e) => e.kind === "references")
      .map((e) => ({
        from: `${byId.get(e.fromNodeId)?.name}${e.meta.fromColumn ? "." + e.meta.fromColumn : ""}`,
        to: `${byId.get(e.toNodeId)?.name}${e.meta.toColumn ? "." + e.meta.toColumn : ""}`,
        cardinality: e.meta.cardinality,
        onDelete: e.meta.onDelete,
      })),
  };
}

/**
 * Bulk position save from the canvas. Layout-only, not logged as events.
 * `placed` marks these positions as deliberately assigned (a drag or resize), so a future
 * auto-layout pass knows to leave them alone; a whole-lens "Tidy" run passes `placed: false`
 * instead, since it's an explicit, visible, user-triggered rearrangement of everything in that lens.
 */
export async function saveLayout(
  actor: Actor,
  teamRef: string,
  positions: { id: string; x: number; y: number; width?: number; height?: number }[],
  opts?: { placed?: boolean },
) {
  const db = await getDb();
  const team = await requireTeam(actor, teamRef, "edit");
  const placed = opts?.placed ?? true;
  await db.transaction(async (tx) => {
    for (const p of positions) {
      await tx
        .update(nodes)
        .set({ x: p.x, y: p.y, ...(p.width ? { width: p.width, height: p.height } : {}), placed })
        .where(and(eq(nodes.id, p.id), eq(nodes.teamId, team.id)));
    }
  });
}

export async function deleteNode(actor: Actor, teamRef: string, ref: string) {
  const db = await getDb();
  const team = await requireTeam(actor, teamRef, "edit");
  return db.transaction(async (tx) => {
    const n = await resolveNode(tx, team.id, ref);
    // Remove the subtree (children reference parent_id without an FK).
    const all = await tx.select({ id: nodes.id, parentId: nodes.parentId }).from(nodes).where(eq(nodes.teamId, team.id));
    const doomed = new Set([n.id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const x of all) if (x.parentId && doomed.has(x.parentId) && !doomed.has(x.id)) {
        doomed.add(x.id);
        grew = true;
      }
    }
    await tx.delete(nodes).where(inArray(nodes.id, [...doomed]));
    await emit(tx, actor, team.id, {
      type: "node.deleted",
      entity: "node",
      entityId: n.id,
      summary: `removed ${n.layer} ${n.kind} "${n.name}"${doomed.size > 1 ? ` and ${doomed.size - 1} nested` : ""}`,
      data: { name: n.name, layer: n.layer },
    });
    return { ok: true };
  });
}

/**
 * Connect two nodes. `depends`: from uses/calls to. `implements`: from (a lower
 * layer, e.g. code) realizes to (a higher layer, e.g. a system or concept).
 */
export async function upsertEdge(
  actor: Actor,
  teamRef: string,
  input: { from: string; to: string; label?: string; kind?: (typeof schema.EDGE_KINDS)[number] },
) {
  const db = await getDb();
  const team = await requireTeam(actor, teamRef, "edit");
  const kind = input.kind ?? "depends";
  return db.transaction(async (tx) => {
    const from = await resolveNode(tx, team.id, input.from);
    const to = await resolveNode(tx, team.id, input.to);
    if (from.id === to.id) throw new ServiceError("invalid", "Can't connect a node to itself");
    if (kind === "implements" && LAYER_RANK[from.layer] <= LAYER_RANK[to.layer])
      throw new ServiceError(
        "invalid",
        `implements goes from a lower layer to a higher one (code → data → system → concept); "${from.name}" is ${from.layer}, "${to.name}" is ${to.layer}`,
      );
    if (kind === "references" && (from.layer !== "data" || to.layer !== "data"))
      throw new ServiceError("invalid", "references connects two data-layer tables (set column.references instead to get column-level links)");
    const [existing] = await tx
      .select()
      .from(edges)
      .where(and(eq(edges.fromNodeId, from.id), eq(edges.toNodeId, to.id), eq(edges.kind, kind)));
    if (existing) {
      if (input.label === undefined || input.label === existing.label) return existing;
      const [e] = await tx.update(edges).set({ label: input.label }).where(eq(edges.id, existing.id)).returning();
      return e;
    }
    const [e] = await tx
      .insert(edges)
      .values({ teamId: team.id, workspaceId: team.workspaceId, fromNodeId: from.id, toNodeId: to.id, kind, label: input.label ?? "" })
      .returning();
    await emit(tx, actor, team.id, {
      type: "edge.created",
      entity: "edge",
      entityId: e.id,
      summary:
        kind === "implements"
          ? `linked ${from.layer} "${from.name}" implements ${to.layer} "${to.name}"`
          : `connected "${from.name}" → "${to.name}"${e.label ? ` (${e.label})` : ""}`,
      data: { kind, from: from.name, to: to.name },
    });
    return e;
  });
}

export async function deleteEdge(actor: Actor, teamRef: string, edgeId: string) {
  const db = await getDb();
  const team = await requireTeam(actor, teamRef, "edit");
  return db.transaction(async (tx) => {
    const [e] = await tx.delete(edges).where(and(eq(edges.id, edgeId), eq(edges.teamId, team.id))).returning();
    if (!e) return { ok: true };
    const names = await tx.select({ id: nodes.id, name: nodes.name }).from(nodes).where(inArray(nodes.id, [e.fromNodeId, e.toNodeId]));
    const name = (id: string) => names.find((n) => n.id === id)?.name ?? "?";
    await emit(tx, actor, team.id, {
      type: "edge.deleted",
      entity: "edge",
      entityId: e.id,
      summary: `removed ${e.kind === "implements" ? "implements link" : "connection"} "${name(e.fromNodeId)}" → "${name(e.toNodeId)}"`,
      data: { kind: e.kind, from: name(e.fromNodeId), to: name(e.toNodeId) },
    });
    return { ok: true };
  });
}

/** Remove a link by endpoints (agent-friendly). */
export async function unlinkNodes(actor: Actor, teamRef: string, input: { from: string; to: string; kind?: (typeof schema.EDGE_KINDS)[number] }) {
  const db = await getDb();
  const team = await requireTeam(actor, teamRef, "edit");
  const from = await resolveNode(db, team.id, input.from);
  const to = await resolveNode(db, team.id, input.to);
  const found = await db
    .select({ id: edges.id })
    .from(edges)
    .where(and(eq(edges.fromNodeId, from.id), eq(edges.toNodeId, to.id), input.kind ? eq(edges.kind, input.kind) : undefined));
  for (const e of found) await deleteEdge(actor, team.id, e.id); // logged like UI deletes
  return { ok: true, removed: found.length };
}

export async function linkIssueNode(actor: Actor, issueRef: string, nodeRef: string, unlink = false) {
  const db = await getDb();
  return db.transaction(async (tx) => {
    const { issue, team, ref } = await resolveIssue(actor, issueRef, tx, "edit");
    const n = await resolveNode(tx, team.id, nodeRef);
    if (unlink) {
      await tx.delete(issueNodes).where(and(eq(issueNodes.issueId, issue.id), eq(issueNodes.nodeId, n.id)));
    } else {
      await tx.insert(issueNodes).values({ issueId: issue.id, nodeId: n.id }).onConflictDoNothing();
    }
    await emit(tx, actor, team.id, {
      type: unlink ? "issue.unlinked" : "issue.linked",
      entity: "issue",
      entityId: issue.id,
      summary: `${unlink ? "unlinked" : "linked"} ${ref} ${unlink ? "from" : "to"} "${n.name}"`,
      data: { ref, node: n.name },
    });
    return { ok: true };
  });
}

// ───────── flows ─────────

export type FlowInput = {
  id?: string;
  name: string;
  description?: string;
  steps?: { node: string; title: string; detail?: string }[];
  /** Optimistic lock, as on nodes: the flow version the caller last read. */
  expectedVersion?: number;
};

/** Create or replace a flow (matched by id, else by name). Steps are replaced wholesale. */
export async function upsertFlow(actor: Actor, teamRef: string, input: FlowInput) {
  const db = await getDb();
  const team = await requireTeam(actor, teamRef, "edit");
  if (!input.name?.trim()) throw new ServiceError("invalid", "Flow name is required");
  return db.transaction(async (tx) => {
    const steps: schema.FlowStep[] | undefined = input.steps
      ? await Promise.all(
          input.steps.map(async (s) => ({
            nodeId: (await resolveNode(tx, team.id, s.node)).id,
            title: s.title.trim(),
            detail: s.detail ?? "",
          })),
        )
      : undefined;
    const [existing] = await tx
      .select()
      .from(flows)
      .where(
        and(
          eq(flows.teamId, team.id),
          input.id && isUuid(input.id) ? eq(flows.id, input.id) : eq(sql`lower(${flows.name})`, (input.id ?? input.name).trim().toLowerCase()),
        ),
      )
      .for("update"); // a second edit from the same version waits here, then sees the first one's version and is refused
    if (existing) {
      if (input.expectedVersion !== undefined && input.expectedVersion !== existing.version) {
        throw new ServiceError("conflict", `Flow "${existing.name}" was changed (version ${existing.version}, you had ${input.expectedVersion}). Re-read and retry.`, { current: existing });
      }
      const [f] = await tx
        .update(flows)
        .set({
          name: input.name.trim(),
          description: input.description ?? existing.description,
          steps: steps ?? existing.steps,
          version: existing.version + 1,
          updatedAt: new Date(),
        })
        .where(eq(flows.id, existing.id))
        .returning();
      await emit(tx, actor, team.id, { type: "flow.updated", entity: "flow", entityId: f.id, summary: `updated flow "${f.name}" (${f.steps.length} steps)`, data: { name: f.name } });
      return f;
    }
    const [f] = await tx
      .insert(flows)
      .values({ teamId: team.id, workspaceId: team.workspaceId, name: input.name.trim(), description: input.description ?? "", steps: steps ?? [] })
      .returning();
    await emit(tx, actor, team.id, { type: "flow.created", entity: "flow", entityId: f.id, summary: `added flow "${f.name}" (${f.steps.length} steps)`, data: { name: f.name } });
    return f;
  });
}

export async function deleteFlow(actor: Actor, teamRef: string, ref: string) {
  const db = await getDb();
  const team = await requireTeam(actor, teamRef, "edit");
  const [f] = await db
    .select()
    .from(flows)
    .where(and(eq(flows.teamId, team.id), isUuid(ref) ? eq(flows.id, ref) : eq(sql`lower(${flows.name})`, ref.toLowerCase())));
  if (!f) throw new ServiceError("not_found", `Flow "${ref}" not found`);
  await db.delete(flows).where(eq(flows.id, f.id));
  await emit(db, actor, team.id, { type: "flow.deleted", entity: "flow", entityId: f.id, summary: `removed flow "${f.name}"` });
  return { ok: true };
}

// ───────── repositories (WH-68) ─────────

export type RepositoryInput = {
  displayName: string;
  role: string;
  provider?: (typeof schema.REPO_PROVIDERS)[number];
  slug?: string;
  githubRepoId?: string | null;
  githubInstallationId?: string | null;
  githubFullName?: string | null;
  defaultBranch?: string;
  pathLimit?: string | null;
  lifecycle?: (typeof schema.REPO_LIFECYCLES)[number];
};

const slugify = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "repo";

/** Map a repository's lifecycle to the map-node status its system node should carry. */
export function statusForLifecycle(lifecycle: (typeof schema.REPO_LIFECYCLES)[number]): (typeof nodes.$inferSelect)["status"] {
  const map = { live: "live", being_replaced: "deprecated", planned: "planned", retired: "deprecated" } satisfies Record<
    (typeof schema.REPO_LIFECYCLES)[number],
    (typeof nodes.$inferSelect)["status"]
  >;
  return map[lifecycle];
}

async function repoSystemNode(actor: Actor, teamId: string, repo: typeof repositories.$inferSelect) {
  await upsertNode(actor, teamId, {
    name: repo.displayName,
    layer: "system",
    kind: "service",
    summary: `Repository: ${repo.role}`,
    anchors: [`${repo.slug}:**`],
    status: statusForLifecycle(repo.lifecycle),
  });
}

export async function listRepositories(actor: Actor, teamRef: string) {
  const db = await getDb();
  const team = await requireTeam(actor, teamRef);
  return db.select().from(repositories).where(eq(repositories.teamId, team.id)).orderBy(asc(repositories.createdAt));
}

async function resolveRepository(q: Q, teamId: string, ref: string) {
  const [r] = await q.select().from(repositories).where(and(eq(repositories.teamId, teamId), isUuid(ref) ? eq(repositories.id, ref) : eq(repositories.slug, ref)));
  if (!r) throw new ServiceError("not_found", `Repository "${ref}" not found`);
  return r;
}

/** Owner-only create/update of a repository's management fields. Owners manage repos; see createIssue for the human/agent split used elsewhere. */
export async function createRepository(actor: Actor, teamRef: string, input: RepositoryInput) {
  if (actor.kind !== "human") throw new ServiceError("forbidden", "Only teammates can add repositories");
  const db = await getDb();
  const team = await requireTeam(actor, teamRef, "edit");
  if (!input.displayName?.trim()) throw new ServiceError("invalid", "displayName is required");
  if (!input.role?.trim()) throw new ServiceError("invalid", "role is required");
  const slug = input.slug?.trim() ? slugify(input.slug) : slugify(input.displayName);
  const [existing] = await db.select().from(repositories).where(and(eq(repositories.teamId, team.id), eq(repositories.slug, slug)));
  if (existing) throw new ServiceError("conflict", `A repository with slug "${slug}" already exists on this team`);
  const [r] = await db
    .insert(repositories)
    .values({
      teamId: team.id,
      workspaceId: team.workspaceId,
      displayName: input.displayName.trim(),
      role: input.role.trim(),
      provider: input.provider ?? "local",
      slug,
      githubRepoId: input.githubRepoId ?? null,
      githubInstallationId: input.githubInstallationId ?? null,
      githubFullName: input.githubFullName ?? null,
      defaultBranch: input.defaultBranch?.trim() || "main",
      pathLimit: input.pathLimit?.trim() || null,
      lifecycle: input.lifecycle ?? "live",
    })
    .returning();
  await emit(db, actor, team.id, { type: "repository.created", entity: "team", entityId: r.id, summary: `added repository "${r.displayName}" (${r.role})` });
  await repoSystemNode(actor, team.id, r);
  return r;
}

export async function updateRepository(actor: Actor, teamRef: string, ref: string, patch: Partial<RepositoryInput>) {
  if (actor.kind !== "human") throw new ServiceError("forbidden", "Only teammates can edit repositories");
  const db = await getDb();
  const team = await requireTeam(actor, teamRef, "edit");
  const existing = await resolveRepository(db, team.id, ref);
  const set: Partial<typeof repositories.$inferInsert> = { updatedAt: new Date() };
  if (patch.displayName !== undefined) set.displayName = patch.displayName.trim();
  if (patch.role !== undefined) set.role = patch.role.trim();
  if (patch.provider !== undefined) set.provider = patch.provider;
  if (patch.githubRepoId !== undefined) set.githubRepoId = patch.githubRepoId;
  if (patch.githubInstallationId !== undefined) set.githubInstallationId = patch.githubInstallationId;
  if (patch.defaultBranch !== undefined) set.defaultBranch = patch.defaultBranch.trim() || "main";
  if (patch.pathLimit !== undefined) set.pathLimit = patch.pathLimit?.trim() || null;
  if (patch.lifecycle !== undefined) set.lifecycle = patch.lifecycle;
  const [r] = await db.update(repositories).set(set).where(eq(repositories.id, existing.id)).returning();
  await emit(db, actor, team.id, { type: "repository.updated", entity: "team", entityId: r.id, summary: `updated repository "${r.displayName}"` });
  if (patch.lifecycle !== undefined && patch.lifecycle !== existing.lifecycle) await repoSystemNode(actor, team.id, r);
  return r;
}

/** Retire a repository (soft: lifecycle -> retired). Never deletes landed history (team_files rows keep their repositoryId). */
export async function retireRepository(actor: Actor, teamRef: string, ref: string) {
  if (actor.kind !== "human") throw new ServiceError("forbidden", "Only teammates can retire repositories");
  const db = await getDb();
  const team = await requireTeam(actor, teamRef, "edit");
  const existing = await resolveRepository(db, team.id, ref);
  const [r] = await db.update(repositories).set({ lifecycle: "retired", updatedAt: new Date() }).where(eq(repositories.id, existing.id)).returning();
  await emit(db, actor, team.id, { type: "repository.retired", entity: "team", entityId: r.id, summary: `retired repository "${r.displayName}"` });
  await repoSystemNode(actor, team.id, r);
  return r;
}

/**
 * Find-or-create used by the file-reporting path (wheelhouse.json names its repository on report;
 * a repo linked locally before this change registers automatically on its next report). `ref` is the
 * repo slug/name (or github id) the client sends; omitted falls back to a team-default row so old
 * CLI versions / repos without wheelhouse.json repo info keep reporting unqualified, as before.
 */
export async function findOrCreateRepository(actor: Actor, teamId: string, ref?: string | null, role = "default") {
  const db = await getDb();
  const slug = slugify(ref?.trim() || "default");
  const [existing] = await db.select().from(repositories).where(and(eq(repositories.teamId, teamId), eq(repositories.slug, slug)));
  if (existing) return existing;
  const [r] = await db
    .insert(repositories)
    .values({ teamId, workspaceId: actor.workspaceId, displayName: ref?.trim() || "Default", role, provider: "local", slug, lifecycle: "live", lastEventAt: new Date() })
    .returning();
  await emit(db, actor, teamId, { type: "repository.created", entity: "team", entityId: r.id, summary: `registered repository "${r.displayName}" from a client report` });
  await repoSystemNode(actor, teamId, r);
  return r;
}

// ───────── freshness ─────────

export const normPath = (p: string) => p.trim().replace(/^\.\//, "").replace(/\\/g, "/");

/**
 * An anchor may carry an optional repo qualifier, "backend:src/**": only files
 * reported under that repo's slug/role match. A bare anchor ("src/db/**") has
 * no qualifier and matches files from any repository (the backward-compat
 * default — existing single-repo teams keep working with no action).
 *
 * Heuristic: a qualifier is a prefix before the first colon, itself containing
 * no "/" and no glob characters — real anchors are repo-relative paths/globs
 * ("src/db/**", "drizzle/**") which never start that way, so this never
 * misparses an existing anchor.
 */
export function parseAnchor(anchor: string): { repo: string | null; pattern: string } {
  const i = anchor.indexOf(":");
  if (i > 0) {
    const prefix = anchor.slice(0, i);
    if (!/[/*?]/.test(prefix)) return { repo: prefix.toLowerCase(), pattern: anchor.slice(i + 1) };
  }
  return { repo: null, pattern: anchor };
}

/**
 * How specifically `anchor` matches `file` (0 = no match). Longer literal
 * prefix = more specific. `fileRepo` is the repo slug/role the file was
 * reported under (from team_files.repositoryId / the session's file
 * tracking); an anchor qualified to a different repo never matches it, and an
 * unqualified anchor matches regardless of `fileRepo` (including when it's
 * unknown/null).
 */
export function anchorScore(anchor: string, file: string, fileRepo?: string | null) {
  const { repo, pattern } = parseAnchor(anchor);
  if (repo && (!fileRepo || fileRepo.toLowerCase() !== repo)) return 0;
  const a = normPath(pattern).split("#")[0];
  const f = normPath(file);
  if (!a) return 0;
  if (/[*?]/.test(a)) {
    const re = new RegExp(
      "^" +
        a
          .replace(/[.+^${}()|[\]\\]/g, "\\$&")
          .replace(/\*\*\/?/g, "\u0000")
          .replace(/\*/g, "[^/]*")
          .replace(/\?/g, "[^/]")
          .replace(/\u0000/g, ".*") +
        "$",
    );
    return re.test(f) ? a.replace(/[*?].*$/, "").length + 1 : 0;
  }
  if (f === a) return a.length + 1000; // exact file beats any directory/glob
  const dir = a.endsWith("/") ? a : a + "/";
  return f.startsWith(dir) ? dir.length : 0;
}

/**
 * Report files changed by a commit/PR/agent session. For each file, the most
 * specifically-anchored nodes are marked stale (so a tweak to service.ts flags
 * the "service layer" node, not every node anchored at src/**).
 */
export async function reportChanges(
  actor: Actor,
  teamRef: string,
  input: { files: string[]; sha?: string; summary?: string; repository?: string },
) {
  const db = await getDb();
  const team = await requireTeam(actor, teamRef, "edit");
  const files = [...new Set(input.files.map(normPath).filter(Boolean))];
  if (!files.length) throw new ServiceError("invalid", "files is empty");
  // Which repo these files belong to, for repo-qualified anchor matching ("backend:src/**").
  // Omitted (old CLI / repos without wheelhouse.json repo info) falls back to the team's
  // unqualified default repo, so unqualified anchors (the common case) keep matching regardless.
  const repo = await findOrCreateRepository(actor, team.id, input.repository);
  const ns = await db.select().from(nodes).where(eq(nodes.teamId, team.id));
  const hits = new Map<string, { node: NodeRow; files: string[] }>();
  for (const f of files) {
    // Most specific match per layer: a change to service.ts flags the
    // "service.ts" code node and the "Service layer" system node, not every
    // node anchored at src/**.
    const best: Partial<Record<Layer, { score: number; nodes: NodeRow[] }>> = {};
    for (const n of ns) {
      const s = Math.max(0, ...n.anchors.map((a) => anchorScore(a, f, repo?.slug)));
      if (!s) continue;
      const b = best[n.layer];
      if (!b || s > b.score) best[n.layer] = { score: s, nodes: [n] };
      else if (s === b.score) b.nodes.push(n);
    }
    for (const n of Object.values(best).flatMap((b) => b!.nodes)) {
      const h = hits.get(n.id) ?? { node: n, files: [] };
      h.files.push(f);
      hits.set(n.id, h);
    }
  }
  const short = input.sha ? input.sha.slice(0, 8) : null;
  // Changes at the commit a node was described at aren't news.
  for (const [id, { node }] of hits) {
    if (input.sha && node.describedSha && (input.sha.startsWith(node.describedSha) || node.describedSha.startsWith(input.sha))) hits.delete(id);
  }

  // Same pipeline for docs (WH-64): a doc anchored to a changed file is flagged, parallel to nodes.
  // No per-layer "most specific" grouping here (docs aren't layered) — any anchor match flags the doc.
  const allDocs = await db.select().from(docs).where(and(eq(docs.teamId, team.id), isNull(docs.deletedAt)));
  const docHits = new Map<string, { doc: DocRow; files: string[] }>();
  for (const f of files) {
    for (const d of allDocs) {
      if (!d.anchors.length) continue;
      if (Math.max(0, ...d.anchors.map((a) => anchorScore(a, f, repo?.slug))) <= 0) continue;
      const h = docHits.get(d.id) ?? { doc: d, files: [] };
      h.files.push(f);
      docHits.set(d.id, h);
    }
  }
  for (const [id, { doc: d }] of docHits) {
    if (input.sha && d.describedSha && (input.sha.startsWith(d.describedSha) || d.describedSha.startsWith(input.sha))) docHits.delete(id);
  }

  return db.transaction(async (tx) => {
    for (const { node, files: fs } of hits.values()) {
      const reason = `${fs.slice(0, 3).join(", ")}${fs.length > 3 ? ` +${fs.length - 3} more` : ""} changed${short ? ` in ${short}` : ""}${input.summary ? `: ${input.summary}` : ""}`;
      await tx.update(nodes).set({ stale: true, staleSource: "report", staleReason: reason.slice(0, 500) }).where(eq(nodes.id, node.id));
    }
    for (const { doc: d, files: fs } of docHits.values()) {
      const reason = `${fs.slice(0, 3).join(", ")}${fs.length > 3 ? ` +${fs.length - 3} more` : ""} changed${short ? ` in ${short}` : ""}${input.summary ? `: ${input.summary}` : ""}`;
      await tx.update(docs).set({ stale: true, staleSource: "report", staleReason: reason.slice(0, 500) }).where(eq(docs.id, d.id));
    }
    const marked = [...hits.values()].map(({ node, files: fs }) => ({ name: node.name, layer: node.layer, files: fs }));
    const docsMarked = [...docHits.values()].map(({ doc: d, files: fs }) => ({ id: d.id, title: d.title, slug: d.slug, files: fs }));
    await emit(tx, actor, team.id, {
      type: "code.changed",
      entity: "team",
      entityId: team.id,
      summary: `reported ${files.length} changed file(s)${short ? ` (${short})` : ""}; ${marked.length} map node(s)${docsMarked.length ? ` and ${docsMarked.length} doc(s)` : ""} need re-describing`,
      data: { sha: input.sha, files: files.slice(0, 50), stale: marked.map((m) => `${m.layer}:${m.name}`), staleDocs: docsMarked.map((m) => m.slug) },
    });
    if (repo) await tx.update(schema.repositories).set({ lastEventAt: new Date() }).where(eq(schema.repositories.id, repo.id));
    const anchoredFiles = new Set<string>();
    for (const n of ns) for (const f of files) if (n.anchors.some((a) => anchorScore(a, f, repo?.slug))) anchoredFiles.add(f);
    for (const d of allDocs) for (const f of files) if (d.anchors.some((a) => anchorScore(a, f, repo?.slug))) anchoredFiles.add(f);
    return {
      files: files.length,
      staleMarked: marked,
      staleDocsMarked: docsMarked,
      unanchored: files.filter((f) => !anchoredFiles.has(f)),
    };
  });
}

export async function listStale(actor: Actor, teamRef: string) {
  const db = await getDb();
  const team = await requireTeam(actor, teamRef);
  const rows = await db
    .select({ id: nodes.id, name: nodes.name, layer: nodes.layer, kind: nodes.kind, reason: nodes.staleReason, anchors: nodes.anchors })
    .from(nodes)
    .where(and(eq(nodes.teamId, team.id), eq(nodes.stale, true)));
  return rows;
}

export async function markFresh(actor: Actor, teamRef: string, ref: string, sha?: string) {
  return upsertNode(actor, teamRef, { id: ref, markFresh: true, describedSha: sha });
}

/** Docs flagged stale (their anchored code changed since last confirmed), with reason and anchors to re-read. */
export async function listStaleDocs(actor: Actor, teamRef: string) {
  const db = await getDb();
  const team = await requireTeam(actor, teamRef);
  return db
    .select({ id: docs.id, slug: docs.slug, title: docs.title, reason: docs.staleReason, anchors: docs.anchors })
    .from(docs)
    .where(and(eq(docs.teamId, team.id), eq(docs.stale, true), isNull(docs.deletedAt)));
}

// ───────── decisions ─────────

export type DecisionInput = {
  number?: number;
  title?: string;
  status?: (typeof schema.DECISION_STATUSES)[number];
  context?: string;
  decision?: string;
  consequences?: string;
  nodes?: string[];
  /** Optimistic lock, as on nodes: the decision version the caller last read (updates only). */
  expectedVersion?: number;
};

export async function listDecisions(actor: Actor, teamRef: string) {
  const db = await getDb();
  const team = await requireTeam(actor, teamRef);
  return withNodeIds(db, await db.select().from(decisions).where(eq(decisions.teamId, team.id)).orderBy(asc(decisions.number)));
}

/** Create (no number) or update (number) an ADR. */
export async function upsertDecision(actor: Actor, teamRef: string, input: DecisionInput) {
  const db = await getDb();
  const team = await requireTeam(actor, teamRef, "edit");
  return db.transaction(async (tx) => {
    const nodeIds = input.nodes ? await Promise.all(input.nodes.map(async (r) => (await resolveNode(tx, team.id, r)).id)) : undefined;
    if (input.number !== undefined) {
      const [d] = await tx.select().from(decisions).where(and(eq(decisions.teamId, team.id), eq(decisions.number, input.number))).for("update");
      if (!d) throw new ServiceError("not_found", `Decision ADR-${input.number} not found`);
      if (input.expectedVersion !== undefined && input.expectedVersion !== d.version) {
        throw new ServiceError("conflict", `ADR-${d.number} was changed (version ${d.version}, you had ${input.expectedVersion}). Re-read and retry.`, { current: (await withNodeIds(tx, [d]))[0] });
      }
      const [current] = await withNodeIds(tx, [d]);
      const patch = {
        title: input.title,
        status: input.status,
        context: input.context,
        decision: input.decision,
        consequences: input.consequences,
        nodeIds,
      };
      const changes = diff(current as unknown as Record<string, unknown>, patch as Record<string, unknown>);
      if (!Object.keys(changes).length) return current;
      const { nodeIds: newNodes, ...columnsPatch } = patch;
      const [row] = await tx
        .update(decisions)
        .set({ ...Object.fromEntries(Object.entries(columnsPatch).filter(([, v]) => v !== undefined)), version: d.version + 1, updatedAt: new Date() })
        .where(eq(decisions.id, d.id))
        .returning();
      if (newNodes) await setDecisionNodes(tx, team, row.id, newNodes);
      const u = { ...row, nodeIds: newNodes ?? current.nodeIds };
      await emit(tx, actor, team.id, {
        type: "decision.updated",
        entity: "decision",
        entityId: u.id,
        summary: `updated ADR-${u.number} "${u.title}": ${Object.keys(changes).join(", ")}`,
        data: { number: u.number },
      });
      return u;
    }
    if (!input.title?.trim()) throw new ServiceError("invalid", "title is required");
    const [{ max }] = await tx
      .select({ max: sql<number>`coalesce(max(${decisions.number}), 0)::int` })
      .from(decisions)
      .where(eq(decisions.teamId, team.id));
    const [d] = await tx
      .insert(decisions)
      .values({
        teamId: team.id,
        workspaceId: team.workspaceId,
        number: Number(max) + 1,
        title: input.title.trim(),
        status: input.status ?? "accepted",
        context: input.context ?? "",
        decision: input.decision ?? "",
        consequences: input.consequences ?? "",
        authorKind: actor.kind,
        authorName: actor.name,
      })
      .returning();
    await setDecisionNodes(tx, team, d.id, nodeIds ?? []);
    await emit(tx, actor, team.id, {
      type: "decision.created",
      entity: "decision",
      entityId: d.id,
      summary: `recorded ADR-${d.number} "${d.title}"`,
      data: { number: d.number },
    });
    return { ...d, nodeIds: [...new Set(nodeIds ?? [])] };
  });
}

// ───────── glossary ─────────

export async function listTerms(actor: Actor, teamRef: string) {
  const db = await getDb();
  const team = await requireTeam(actor, teamRef);
  return db.select().from(terms).where(eq(terms.teamId, team.id)).orderBy(asc(terms.term));
}

export async function upsertTerm(actor: Actor, teamRef: string, input: { term: string; definition: string; node?: string | null }) {
  const db = await getDb();
  const team = await requireTeam(actor, teamRef, "edit");
  const term = input.term?.trim();
  if (!term || !input.definition?.trim()) throw new ServiceError("invalid", "term and definition are required");
  return db.transaction(async (tx) => {
    const nodeId = input.node === null ? null : input.node ? (await resolveNode(tx, team.id, input.node)).id : undefined;
    const [existing] = await tx
      .select()
      .from(terms)
      .where(and(eq(terms.teamId, team.id), eq(sql`lower(${terms.term})`, term.toLowerCase())));
    if (existing) {
      if (existing.definition === input.definition.trim() && (nodeId === undefined || nodeId === existing.nodeId) && existing.term === term) return existing;
      const [t] = await tx
        .update(terms)
        .set({ term, definition: input.definition.trim(), ...(nodeId !== undefined ? { nodeId } : {}), updatedAt: new Date() })
        .where(eq(terms.id, existing.id))
        .returning();
      await emit(tx, actor, team.id, { type: "term.updated", entity: "term", entityId: t.id, summary: `updated glossary term "${t.term}"` });
      return t;
    }
    const [t] = await tx
      .insert(terms)
      .values({ teamId: team.id, workspaceId: team.workspaceId, term, definition: input.definition.trim(), nodeId: nodeId ?? null })
      .returning();
    await emit(tx, actor, team.id, { type: "term.created", entity: "term", entityId: t.id, summary: `defined glossary term "${t.term}"` });
    return t;
  });
}

export async function deleteTerm(actor: Actor, teamRef: string, term: string) {
  const db = await getDb();
  const team = await requireTeam(actor, teamRef, "edit");
  const [t] = await db
    .select()
    .from(terms)
    .where(and(eq(terms.teamId, team.id), isUuid(term) ? eq(terms.id, term) : eq(sql`lower(${terms.term})`, term.toLowerCase())));
  if (!t) throw new ServiceError("not_found", `Term "${term}" not found`);
  await db.delete(terms).where(eq(terms.id, t.id));
  await emit(db, actor, team.id, { type: "term.deleted", entity: "term", entityId: t.id, summary: `removed glossary term "${t.term}"` });
  return { ok: true };
}

// ───────────────────────── events / AI queue ─────────────────────────

export async function listEvents(actor: Actor, teamRef: string, opts: { afterSeq?: number; limit?: number; actorKind?: "human" | "agent" } = {}) {
  const db = await getDb();
  const team = await requireTeam(actor, teamRef);
  return db
    .select()
    .from(events)
    .where(
      and(
        eq(events.teamId, team.id),
        opts.afterSeq ? gt(events.seq, opts.afterSeq) : undefined,
        opts.actorKind ? eq(events.actorKind, opts.actorKind) : undefined,
      ),
    )
    .orderBy(opts.afterSeq ? asc(events.seq) : desc(events.seq))
    .limit(Math.min(opts.limit ?? 100, 500));
}

/**
 * Where an agent's queue starts in a team. With no explicit cursor, a key
 * starts at the moment it was created: a new agent doesn't inherit the whole
 * team history as "unread".
 */
async function cursorFor(q: Q, key: { id: string; createdAt: Date }, teamId: string) {
  const [cur] = await q
    .select()
    .from(agentCursors)
    .where(and(eq(agentCursors.apiKeyId, key.id), eq(agentCursors.teamId, teamId)));
  if (cur) return cur.lastSeq;
  const [row] = await q
    .select({ seq: sql<number>`coalesce(max(${events.seq}), 0)` })
    .from(events)
    .where(and(eq(events.teamId, teamId), lte(events.createdAt, key.createdAt)));
  return Number(row?.seq ?? 0);
}

async function keyRow(q: Q, keyId: string) {
  const [k] = await q.select().from(schema.apiKeys).where(eq(schema.apiKeys.id, keyId));
  if (!k) throw new ServiceError("not_found", "API key not found");
  return k;
}

/**
 * Changes the caller didn't make itself. A caller that names its session excludes
 * only that session's writes, so sessions sharing one API key see each other's
 * work; without a session, everything written with the key is excluded.
 */
const notMine = (who: { id: string; sessionId?: string }) =>
  who.sessionId
    ? sql`${events.sessionId} is distinct from ${who.sessionId}`
    : or(ne(events.actorKind, "agent"), ne(events.actorId, who.id));

/**
 * Agents may name their client session (Claude Code session_id) on any call.
 * A session already registered by another key is refused; an unknown one is
 * fine (it's registered when the session first reads its queue).
 */
export async function checkSession(actor: Actor) {
  if (actor.kind !== "agent" || !actor.sessionId) return;
  const db = await getDb();
  const [s] = await db.select({ apiKeyId: workSessions.apiKeyId }).from(workSessions).where(eq(workSessions.id, actor.sessionId));
  if (s && s.apiKeyId !== actor.id) throw new ServiceError("forbidden", "That session belongs to another API key");
}

/**
 * Marks the calling session active (every call that names one, reads included) so
 * "last seen" is real. A session a teammate had removed is restored on its first
 * call: it jumps to the top of the queue (nothing replayed, nothing blocked) and
 * remembers where it was, so the agent can opt into the missed changes with
 * resume_session.
 */
export async function touchSession(actor: Actor) {
  if (actor.kind !== "agent" || !actor.sessionId) return;
  const db = await getDb();
  const [s] = await db.select().from(workSessions).where(eq(workSessions.id, actor.sessionId));
  if (!s || s.apiKeyId !== actor.id) return;
  if (s.removedAt) {
    const [{ head }] = await db
      .select({ head: sql<number>`coalesce(max(${events.seq}), 0)` })
      .from(events)
      .where(eq(events.teamId, s.teamId));
    await db
      .update(workSessions)
      .set({
        removedAt: null,
        resumeFromSeq: s.lastSeq ?? Number(head),
        resumeRemovedAt: s.removedAt,
        lastSeq: Number(head),
        lastSeenAt: new Date(),
        endedAt: null,
      })
      .where(eq(workSessions.id, s.id));
    return;
  }
  await db.update(workSessions).set({ lastSeenAt: new Date(), endedAt: null }).where(eq(workSessions.id, s.id));
}

/** Set on get_briefing / get_changes responses while a restored session hasn't chosen replay or skip. */
export async function sessionNotice(actor: Actor) {
  if (actor.kind !== "agent" || !actor.sessionId) return null;
  const db = await getDb();
  const [s] = await db.select().from(workSessions).where(eq(workSessions.id, actor.sessionId));
  if (!s || s.apiKeyId !== actor.id || s.resumeFromSeq == null) return null;
  const [{ n }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(events)
    .where(and(eq(events.teamId, s.teamId), gt(events.seq, s.resumeFromSeq), notMine({ id: actor.id, sessionId: s.id })));
  return {
    removedAt: s.resumeRemovedAt,
    missedChanges: Number(n),
    next: "A teammate removed this session from Wheelhouse and it has reconnected at the top of the queue. Ask the user whether to replay the missed changes or skip them, then call resume_session with mode replay or skip.",
  };
}

/** The agent's answer to session_removed: replay the changes missed while removed, or stay at the top of the queue. */
export async function resumeSession(actor: Actor, teamRef: string, mode: "replay" | "skip") {
  if (actor.kind !== "agent" || !actor.sessionId) throw new ServiceError("invalid", "resume_session is for an agent session");
  const db = await getDb();
  const team = await requireTeam(actor, teamRef);
  const [s] = await db.select().from(workSessions).where(eq(workSessions.id, actor.sessionId));
  if (!s || s.apiKeyId !== actor.id || s.teamId !== team.id) throw new ServiceError("not_found", "Session not found");
  if (s.resumeFromSeq == null) throw new ServiceError("invalid", "Nothing to resume: this session was not removed");
  const [{ head }] = await db.select({ head: sql<number>`coalesce(max(${events.seq}), 0)` }).from(events).where(eq(events.teamId, team.id));
  const cursor = mode === "replay" ? s.resumeFromSeq : Number(head);
  await db.update(workSessions).set({ lastSeq: cursor, resumeFromSeq: null, resumeRemovedAt: null }).where(eq(workSessions.id, s.id));
  return { ok: true, mode, cursor };
}

/** A teammate removes a session from the lists (soft delete: kept 30 days so a reconnect is recognised). */
export async function removeSession(actor: Actor, teamRef: string, sessionId: string) {
  if (actor.kind !== "human") throw new ServiceError("forbidden", "Only teammates can remove a session");
  const db = await getDb();
  const team = await requireTeam(actor, teamRef);
  const removed = await db
    .update(workSessions)
    .set({ removedAt: new Date() })
    .where(and(eq(workSessions.id, sessionId), eq(workSessions.teamId, team.id), isNull(workSessions.removedAt)))
    .returning({ id: workSessions.id });
  if (!removed.length) throw new ServiceError("not_found", "Session not found");
  return { ok: true };
}

/**
 * Housekeeping, run whenever sessions are read or end: sessions idle for over a
 * week are deleted, and removed ones are purged after 30 days. A session a
 * pending map draft still points at is kept.
 */
export async function pruneSessions(q: Q, teamId: string) {
  const now = Date.now();
  await q.delete(workSessions).where(
    and(
      eq(workSessions.teamId, teamId),
      or(
        and(isNull(workSessions.removedAt), lt(workSessions.lastSeenAt, new Date(now - SESSION_IDLE_LIMIT_MS))),
        lt(workSessions.removedAt, new Date(now - REMOVED_KEEP_MS)),
      ),
      sql`not exists (select 1 from ${schema.nodeDrafts} where ${schema.nodeDrafts.sessionId} = ${workSessions.id} and ${schema.nodeDrafts.status} = 'pending')`,
    ),
  );
}

/**
 * The calling session's own cursor, registering the session on first use. A new
 * session starts where its key's cursor is: its briefing covers current state,
 * so it needs changes from now on, not a replay of what other sessions handled.
 */
async function sessionCursor(q: Q, actor: Actor, teamId: string) {
  const id = actor.sessionId!;
  const [s] = await q.select().from(workSessions).where(eq(workSessions.id, id));
  if (s && s.apiKeyId !== actor.id) throw new ServiceError("forbidden", "That session belongs to another API key");
  if (s && s.teamId !== teamId) throw new ServiceError("invalid", "That session belongs to another team");
  if (s?.lastSeq != null) return s.lastSeq;
  const start = await cursorFor(q, await keyRow(q, actor.id), teamId);
  if (s) await q.update(workSessions).set({ lastSeq: start }).where(eq(workSessions.id, id));
  else
    await q
      .insert(workSessions)
      .values({ id, teamId, workspaceId: actor.workspaceId, apiKeyId: actor.id, actorName: actor.name, lastSeq: start })
      .onConflictDoNothing();
  return start;
}

/**
 * The AI queue: changes since this agent's cursor, excluding the agent's own
 * writes. Humans rearranging the board, editing issues, or commenting show up
 * here. Call `ackChanges` with the last seq you processed.
 *
 * Large backlogs come back as a summary (counts by type and by who) plus the
 * oldest `limit` changes, so an agent returning after a long break isn't
 * flooded; `latestSeq` lets it ack everything once it has skimmed the summary.
 */
export async function getChanges(actor: Actor, teamRef: string, limit = 50) {
  if (actor.kind !== "agent") throw new ServiceError("forbidden", "The change queue is per agent API key");
  const db = await getDb();
  const team = await requireTeam(actor, teamRef);
  const after = actor.sessionId ? await sessionCursor(db, actor, team.id) : await cursorFor(db, await keyRow(db, actor.id), team.id);
  const pending = and(eq(events.teamId, team.id), gt(events.seq, after), notMine(actor));
  const cap = Math.min(Math.max(limit, 1), 200);
  const rows = await db.select().from(events).where(pending).orderBy(asc(events.seq)).limit(cap);
  const [{ total, latest }] = await db
    .select({ total: sql<number>`count(*)::int`, latest: sql<number>`coalesce(max(${events.seq}), 0)` })
    .from(events)
    .where(pending);
  const summary =
    Number(total) > cap
      ? {
          byType: Object.fromEntries(
            (
              await db
                .select({ type: events.type, n: sql<number>`count(*)::int` })
                .from(events)
                .where(pending)
                .groupBy(events.type)
            ).map((r) => [r.type, Number(r.n)]),
          ),
          byActor: Object.fromEntries(
            (
              await db
                .select({ who: events.actorName, n: sql<number>`count(*)::int` })
                .from(events)
                .where(pending)
                .groupBy(events.actorName)
            ).map((r) => [r.who, Number(r.n)]),
          ),
          note: `Showing the oldest ${cap} of ${total} changes. Skim the summary, check get_board for current state, then ack_changes with latestSeq (${latest}) to catch up, or page through by acking the last seq shown.`,
        }
      : undefined;
  // Map nodes whose code changed since they were last described: re-read the
  // anchored files and update the explainer (that clears the flag).
  const stale = await db
    .select({ name: nodes.name, layer: nodes.layer, reason: nodes.staleReason, anchors: nodes.anchors })
    .from(nodes)
    .where(and(eq(nodes.teamId, team.id), eq(nodes.stale, true)))
    .limit(50);
  // Same, for docs (WH-64): a doc whose anchored files changed since it was last confirmed accurate.
  const staleDocs = await db
    .select({ slug: docs.slug, title: docs.title, reason: docs.staleReason, anchors: docs.anchors })
    .from(docs)
    .where(and(eq(docs.teamId, team.id), eq(docs.stale, true), isNull(docs.deletedAt)))
    .limit(50);
  return {
    session: actor.sessionId ?? null,
    cursor: after,
    total: Number(total),
    latestSeq: Number(latest) || after,
    changes: rows,
    hasMore: Number(total) > rows.length,
    ...(summary ? { summary } : {}),
    staleNodes: stale,
    staleDocs,
  };
}

export async function ackChanges(actor: Actor, teamRef: string, seq: number) {
  if (actor.kind !== "agent") throw new ServiceError("forbidden", "The change queue is per agent API key");
  const db = await getDb();
  const team = await requireTeam(actor, teamRef);
  if (actor.sessionId) {
    await sessionCursor(db, actor, team.id);
    await db
      .update(workSessions)
      .set({ lastSeq: sql`greatest(coalesce(${workSessions.lastSeq}, 0), ${seq})`, lastSeenAt: new Date() })
      .where(eq(workSessions.id, actor.sessionId));
  }
  // The key-level cursor follows the furthest any session has read: new sessions start there.
  await db
    .insert(agentCursors)
    .values({ apiKeyId: actor.id, teamId: team.id, workspaceId: team.workspaceId, lastSeq: seq })
    .onConflictDoUpdate({
      target: [agentCursors.apiKeyId, agentCursors.teamId],
      set: { lastSeq: sql`greatest(${agentCursors.lastSeq}, ${seq})` },
    });
  // An ack is not an event in the log, but it changes the Bots menu's queue counts: tell open browsers (WH-1).
  bus.publish({ workspaceId: actor.workspaceId, teamId: team.id, type: "queue.changed", actorKind: "agent", actorName: actor.name });
  return { ok: true, cursor: seq, session: actor.sessionId ?? null };
}

/**
 * Human reset: mark everything as seen for one agent key (or every key), in one
 * team or all of the workspace's teams. Used after demos, long breaks, or when
 * a backlog isn't worth replaying.
 */
export async function markAllSeen(actor: Actor, opts: { keyId?: string; teamRef?: string } = {}) {
  if (actor.kind !== "human") throw new ServiceError("forbidden", "Only teammates can reset an agent's queue");
  const db = await getDb();
  const keys = await db
    .select({ id: schema.apiKeys.id })
    .from(schema.apiKeys)
    .where(and(eq(schema.apiKeys.workspaceId, actor.workspaceId), opts.keyId ? eq(schema.apiKeys.id, opts.keyId) : undefined));
  if (opts.keyId && !keys.length) throw new ServiceError("not_found", "API key not found");
  const ps = opts.teamRef ? [await requireTeam(actor, opts.teamRef)] : await listTeams(actor);
  let reset = 0;
  await db.transaction(async (tx) => {
    for (const p of ps) {
      const [{ head }] = await tx
        .select({ head: sql<number>`coalesce(max(${events.seq}), 0)` })
        .from(events)
        .where(eq(events.teamId, p.id));
      for (const k of keys) {
        await tx
          .insert(agentCursors)
          .values({ apiKeyId: k.id, teamId: p.id, workspaceId: p.workspaceId, lastSeq: Number(head) })
          .onConflictDoUpdate({ target: [agentCursors.apiKeyId, agentCursors.teamId], set: { lastSeq: sql`greatest(${agentCursors.lastSeq}, ${Number(head)})` } });
        await tx
          .update(workSessions)
          .set({ lastSeq: Number(head) })
          .where(and(eq(workSessions.apiKeyId, k.id), eq(workSessions.teamId, p.id), isNull(workSessions.removedAt)));
        reset++;
      }
    }
  });
  return { ok: true, reset };
}

/**
 * Pending queue depth per agent key, shown in the UI so humans know what the AI
 * hasn't seen yet. Each session (not ended, not removed, active within a week)
 * reports its own depth and the recency bucket it falls into. The key's `pending`
 * counts only sessions active in the last 6 hours, so dead ones don't inflate it.
 */
export async function queueStatus(actor: Actor, teamRef: string) {
  const db = await getDb();
  const team = await requireTeam(actor, teamRef);
  await pruneSessions(db, team.id);
  const keys = await db
    .select({ id: schema.apiKeys.id, name: schema.apiKeys.name, lastUsedAt: schema.apiKeys.lastUsedAt, createdAt: schema.apiKeys.createdAt })
    .from(schema.apiKeys)
    .where(and(eq(schema.apiKeys.workspaceId, actor.workspaceId), sql`${schema.apiKeys.revokedAt} is null`));
  const out = [];
  for (const { createdAt, ...k } of keys) {
    const after = await cursorFor(db, { id: k.id, createdAt }, team.id);
    const depth = async (from: number, who: { id: string; sessionId?: string }) => {
      const [{ n }] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(events)
        .where(and(eq(events.teamId, team.id), gt(events.seq, from), notMine(who)));
      return Number(n);
    };
    const active = await db
      .select({
        id: workSessions.id,
        lastSeq: workSessions.lastSeq,
        lastSeenAt: workSessions.lastSeenAt,
        branch: workSessions.branch,
        issueNumber: issues.number,
      })
      .from(workSessions)
      .leftJoin(issues, eq(issues.id, workSessions.issueId))
      .where(
        and(
          eq(workSessions.apiKeyId, k.id),
          eq(workSessions.teamId, team.id),
          isNull(workSessions.endedAt),
          isNull(workSessions.removedAt),
          gt(workSessions.lastSeenAt, new Date(Date.now() - SESSION_IDLE_LIMIT_MS)),
        ),
      );
    const now = Date.now();
    const sessions = [];
    for (const s of active)
      sessions.push({
        id: s.id,
        lastSeenAt: s.lastSeenAt,
        bucket: bucketOf(s.lastSeenAt, now)!,
        // A session that never read its queue has no cursor of its own; don't pass it off as caught up.
        reading: s.lastSeq != null,
        branch: s.branch,
        issue: s.issueNumber == null ? null : `${team.key}-${s.issueNumber}`,
        pending: s.lastSeq == null ? 0 : await depth(s.lastSeq, { id: k.id, sessionId: s.id }),
      });
    sessions.sort((x, y) => y.lastSeenAt.getTime() - x.lastSeenAt.getTime());
    const recent = sessions.filter((s) => s.bucket === "h6");
    const pending = recent.length ? Math.max(...recent.map((s) => s.pending)) : await depth(after, { id: k.id });
    out.push({ ...k, pending, sessions });
  }
  return out;
}

// ───────── setup checklist (WH-69) ─────────

/**
 * Gathers the rows checklistStatus() needs and computes the team's setup-checklist state. Shared by the
 * team-page banner and the agent briefing so the two can't say different things about what's connected.
 */
export async function checklistForTeam(actor: Actor, teamRef: string): Promise<ChecklistState> {
  const db = await getDb();
  const team = await requireTeam(actor, teamRef);
  const [repos, [{ count: sessionCount }], [{ count: activeAgentKeyCount }], [{ count: nodeCount }], [{ count: memberCount }], [{ count: pendingInviteCount }]] =
    await Promise.all([
      db.select({ provider: repositories.provider, lifecycle: repositories.lifecycle }).from(repositories).where(eq(repositories.teamId, team.id)),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(workSessions)
        .where(eq(workSessions.teamId, team.id)),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(schema.apiKeys)
        .innerJoin(schema.apiKeyTeams, eq(schema.apiKeyTeams.apiKeyId, schema.apiKeys.id))
        .where(and(eq(schema.apiKeyTeams.teamId, team.id), isNull(schema.apiKeys.revokedAt))),
      db.select({ count: sql<number>`count(*)::int` }).from(nodes).where(eq(nodes.teamId, team.id)),
      db.select({ count: sql<number>`count(*)::int` }).from(schema.memberships).where(eq(schema.memberships.workspaceId, team.workspaceId)),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(schema.invites)
        .where(
          and(
            eq(schema.invites.kind, "join_workspace"),
            eq(schema.invites.workspaceId, team.workspaceId),
            isNull(schema.invites.usedAt),
            isNull(schema.invites.revokedAt),
            gt(schema.invites.expiresAt, new Date()),
          ),
        ),
    ]);
  return checklistStatus({
    teamKey: team.key,
    repositories: repos,
    sessionCount,
    activeAgentKeyCount,
    nodeCount,
    memberCount,
    pendingInviteCount,
  });
}

// ───────────────────────── workspace documentation (WH-51) ─────────────────────────
//
// Markdown docs stored in Wheelhouse, next to the board and map: runbooks, product
// notes, conventions, onboarding, decisions in prose. A tree via parentId, optimistic
// locking like issues, soft delete (30-day purge; history lives in `events`). Reading
// is open to any key; writing (upsertDoc/deleteDoc/moveDoc) requires a human actor or
// a key with the "docs:write" capability — enforced here, and again at the tool layer
// so a future caller of these functions can't skip the check by mistake.

export const DOC_BODY_MAX_BYTES = 200_000; // 200 KB
export const DOC_MAX_DEPTH = 4;
export const DOC_MAX_PER_TEAM = 500;

export type DocRow = typeof docs.$inferSelect;

/** Humans can always write docs; agent keys need the "docs:write" capability. */
export function canWriteDocs(actor: Actor, capabilities?: string[]) {
  if (actor.kind === "human") return true;
  return (capabilities ?? []).includes("docs:write");
}

async function assertDocsWritable(actor: Actor, q: Q) {
  if (actor.kind === "human") return;
  const [key] = await q.select({ capabilities: apiKeys.capabilities }).from(apiKeys).where(eq(apiKeys.id, actor.id));
  if (!canWriteDocs(actor, key?.capabilities)) {
    throw new ServiceError("forbidden", 'This API key cannot write docs. Ask a teammate to grant it the "docs:write" capability, or write docs as a human.');
  }
}

/** Accepts a doc uuid, or a "slug" / "parent-slug/slug" path, scoped to one team. Never returns a soft-deleted doc. */
async function resolveDoc(q: Q, teamId: string, ref: string) {
  if (isUuid(ref)) {
    const [d] = await q.select().from(docs).where(and(eq(docs.id, ref), eq(docs.teamId, teamId), isNull(docs.deletedAt)));
    if (!d) throw new ServiceError("not_found", `Doc ${ref} not found`);
    return d;
  }
  // Walk a "/"-separated slug path from the root.
  const parts = ref.split("/").filter(Boolean);
  if (!parts.length) throw new ServiceError("invalid", "Doc ref is required");
  let parentId: string | null = null;
  let found: DocRow | undefined;
  for (const slug of parts) {
    const [d] = await q
      .select()
      .from(docs)
      .where(and(eq(docs.teamId, teamId), eq(docs.slug, slug), isNull(docs.deletedAt), parentId === null ? isNull(docs.parentId) : eq(docs.parentId, parentId)));
    if (!d) throw new ServiceError("not_found", `Doc "${ref}" not found`);
    found = d;
    parentId = d.id;
  }
  return found!;
}

function slugifyDoc(title: string) {
  return (
    title
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "doc"
  );
}

/** Depth of `parentId` itself (root = 0), by walking up its own ancestor chain. */
async function depthOf(q: Q, teamId: string, parentId: string | null): Promise<number> {
  let depth = 0;
  let cur = parentId;
  while (cur) {
    const [p] = await q.select({ parentId: docs.parentId }).from(docs).where(and(eq(docs.id, cur), eq(docs.teamId, teamId)));
    if (!p) break;
    cur = p.parentId;
    if (cur) depth += 1; // only count a hop to another ancestor, not the starting node itself
    if (depth > DOC_MAX_DEPTH + 1) break; // guard against a cycle somehow sneaking in
  }
  return depth;
}

async function uniqueSlug(q: Q, teamId: string, parentId: string | null, base: string, excludeId?: string) {
  let slug = base;
  for (let i = 1; i < 50; i++) {
    const [clash] = await q
      .select({ id: docs.id })
      .from(docs)
      .where(
        and(
          eq(docs.teamId, teamId),
          eq(docs.slug, slug),
          isNull(docs.deletedAt),
          parentId === null ? isNull(docs.parentId) : eq(docs.parentId, parentId),
          excludeId ? ne(docs.id, excludeId) : undefined,
        ),
      );
    if (!clash) return slug;
    slug = `${base}-${i + 1}`;
  }
  throw new ServiceError("conflict", `Could not find a free slug for "${base}"`);
}

export type DocInput = {
  title?: string;
  body?: string;
  parent?: string | null; // parent doc ref (uuid or slug path); null = top level
  slug?: string; // explicit slug override; defaults to slugify(title)
  anchors?: string[]; // author-confirmed file paths/globs this doc describes (WH-64 freshness)
  describedSha?: string;
  markFresh?: boolean; // clear stale without changing title/body, recording who confirmed via updatedByKind/updatedById
  template?: string; // WH-65: template id to seed `body` from on create, if no explicit body is given
};

/**
 * Lightweight heuristic (WH-64, scope B): pull file-path-looking tokens out of a doc's
 * Markdown — inline code spans (`` `src/lib/x.ts` ``) and bare tokens that look like a
 * repo-relative path (contain a "/" and end in a plausible extension, or end in "/" for
 * a directory). Not an NLP system — a few false negatives/positives are fine, since the
 * issue says these are SUGGESTIONS the author confirms, never auto-applied.
 */
const PATH_TOKEN_RE = /[A-Za-z0-9_.*-]+(?:\/[A-Za-z0-9_.*-]+)+\/?/g;
const LIKELY_PATH_RE = /^(?:[A-Za-z0-9_.-]+\/)+(?:[A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,8}|\*\*?|[A-Za-z0-9_.*-]+)\/?$/;

export function extractPathTokens(markdown: string): string[] {
  const codeSpans = [...markdown.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]);
  const bare = [...markdown.matchAll(PATH_TOKEN_RE)].map((m) => m[0]);
  const candidates = [...codeSpans, ...bare].map((s) => s.trim().replace(/[.,;:!?)]+$/, "")).filter(Boolean);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of candidates) {
    const p = normPath(c);
    if (!LIKELY_PATH_RE.test(p) && !/[*?]/.test(p)) continue;
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

/**
 * Candidate anchors for a doc: path-like tokens found in its body, plus the anchors of
 * any map nodes it's linked to. Never applied automatically — surfaced for the author
 * to accept/reject (upsert_doc / the docs UI pass `anchors` explicitly to confirm them).
 */
export async function suggestDocAnchors(actor: Actor, teamRef: string, ref: string): Promise<string[]> {
  const db = await getDb();
  const team = await requireTeam(actor, teamRef);
  const d = await resolveDoc(db, team.id, ref);
  const fromBody = extractPathTokens(d.body);
  const linkedNodeIds = await db.select({ nodeId: docNodes.nodeId }).from(docNodes).where(eq(docNodes.docId, d.id));
  const fromNodes = linkedNodeIds.length
    ? (await db.select({ anchors: nodes.anchors }).from(nodes).where(inArray(nodes.id, linkedNodeIds.map((x) => x.nodeId)))).flatMap((n) => n.anchors)
    : [];
  return [...new Set([...fromBody, ...fromNodes])].filter((a) => !d.anchors.includes(a));
}

/** Static list of the five doc templates (id/name/description, no bodies) — no DB access needed. */
export function listDocTemplates() {
  return listDocTemplatesStatic();
}

/** The tree of a team's (non-deleted) docs: id, slug, title, parentId, position, updatedAt. */
export async function listDocs(actor: Actor, teamRef: string, parentRef?: string) {
  const db = await getDb();
  const team = await requireTeam(actor, teamRef);
  const parentId = parentRef ? (await resolveDoc(db, team.id, parentRef)).id : undefined;
  const rows = await db
    .select({
      id: docs.id,
      parentId: docs.parentId,
      slug: docs.slug,
      title: docs.title,
      version: docs.version,
      position: docs.position,
      updatedAt: docs.updatedAt,
      stale: docs.stale,
    })
    .from(docs)
    .where(and(eq(docs.teamId, team.id), isNull(docs.deletedAt)))
    .orderBy(asc(docs.position));
  if (parentRef !== undefined) return rows.filter((d) => d.parentId === parentId);
  return rows;
}

export async function getDoc(actor: Actor, teamRef: string, ref: string) {
  const db = await getDb();
  const team = await requireTeam(actor, teamRef);
  const d = await resolveDoc(db, team.id, ref);
  const linked = await db
    .select({ id: nodes.id, name: nodes.name, kind: nodes.kind, layer: nodes.layer })
    .from(docNodes)
    .innerJoin(nodes, eq(nodes.id, docNodes.nodeId))
    .where(eq(docNodes.docId, d.id));
  // Who wrote it (WH-103): the owner is whoever created the doc; contributors are everyone else who changed it, from the event log
  // (which keeps the name they had at the time, so an agent or a person who has left still has one).
  const touched = await db
    .select({ type: events.type, actorKind: events.actorKind, actorId: events.actorId, actorName: events.actorName })
    .from(events)
    .where(and(eq(events.workspaceId, team.workspaceId), eq(events.entity, "doc"), eq(events.entityId, d.id), inArray(events.type, ["doc.created", "doc.updated"])))
    .orderBy(asc(events.seq));
  const created = touched.find((e) => e.type === "doc.created");
  const [owner] = d.createdByKind === "human" && d.createdById ? await db.select({ name: users.name }).from(users).where(eq(users.id, d.createdById)) : [];
  const ownerName = owner?.name ?? created?.actorName ?? (d.createdByKind === "agent" ? "Agent" : "Someone");
  const seenPeople = new Set([`${d.createdByKind}:${d.createdById}`]);
  const contributors: { kind: "human" | "agent"; id: string | null; name: string }[] = [];
  for (const e of touched) {
    const k = `${e.actorKind}:${e.actorId}`;
    if (seenPeople.has(k)) continue;
    seenPeople.add(k);
    contributors.push({ kind: e.actorKind, id: e.actorId, name: e.actorName });
  }
  return { doc: d, nodes: linked, owner: { kind: d.createdByKind, id: d.createdById, name: ownerName }, contributors };
}

export async function createDoc(actor: Actor, teamRef: string, input: DocInput & { title: string }) {
  const db = await getDb();
  const team = await requireTeam(actor, teamRef, "edit");
  await assertDocsWritable(actor, db);
  if (!input.title?.trim()) throw new ServiceError("invalid", "title is required");
  // WH-65: explicit body always wins; the template is only a convenience default for a blank doc.
  const body = input.body ?? getDocTemplate(input.template)?.body ?? "";
  const bodyBytes = Buffer.byteLength(body, "utf8");
  if (bodyBytes > DOC_BODY_MAX_BYTES) throw new ServiceError("invalid", `Doc body is ${bodyBytes} bytes; the limit is ${DOC_BODY_MAX_BYTES} (200 KB)`);

  return db.transaction(async (tx) => {
    const parentId = input.parent === null || input.parent === undefined ? null : (await resolveDoc(tx, team.id, input.parent)).id;
    const depth = await depthOf(tx, team.id, parentId);
    if (depth + 1 > DOC_MAX_DEPTH) throw new ServiceError("invalid", `Docs can nest at most ${DOC_MAX_DEPTH} levels deep`);
    const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(docs).where(and(eq(docs.teamId, team.id), isNull(docs.deletedAt)));
    if (n >= DOC_MAX_PER_TEAM) throw new ServiceError("invalid", `This team already has ${DOC_MAX_PER_TEAM} docs, the limit`);

    const base = slugifyDoc(input.slug ?? input.title);
    const slug = await uniqueSlug(tx, team.id, parentId, base);
    const siblings = await tx.select({ position: docs.position }).from(docs).where(and(eq(docs.teamId, team.id), isNull(docs.deletedAt), parentId === null ? isNull(docs.parentId) : eq(docs.parentId, parentId)));
    const position = siblings.length ? Math.max(...siblings.map((s) => s.position)) + 1000 : 1000;

    const anchors = input.anchors ?? [];
    const [d] = await tx
      .insert(docs)
      .values({
        teamId: team.id,
        workspaceId: team.workspaceId,
        parentId,
        slug,
        title: input.title.trim(),
        body,
        position,
        anchors,
        describedHashes: await landedHashesFor(tx, team.id, anchors),
        describedSha: input.describedSha ?? null,
        describedAt: new Date(),
        createdByKind: actor.kind,
        createdById: actor.id,
        updatedByKind: actor.kind,
        updatedById: actor.id,
      })
      .returning();
    await emit(tx, actor, team.id, {
      type: "doc.created",
      entity: "doc",
      entityId: d.id,
      summary: `created doc "${d.title}"`,
      data: { slug: d.slug, title: d.title },
    });
    return d;
  });
}

export type DocUpdateInput = Pick<DocInput, "title" | "body" | "anchors" | "describedSha" | "markFresh"> & {
  labels?: string[]; // WH-103: free-text tags; they never affect freshness
  forcePublish?: boolean; // skip the in-flux draft check (used when publishing a draft on land)
  describedHashes?: Record<string, string>; // content hashes the edit/confirmation was made against
};

/**
 * Patch a doc's title/body/anchors, or just confirm it's still accurate (markFresh).
 * Pass `expectedVersion` for optimistic locking, same pattern as updateIssue.
 *
 * Mirrors upsertNode: an agent session editing a doc whose anchored files are still
 * in flux (changed in that same session, not landed) gets the edit stored as a
 * doc_drafts row instead of applied directly — published when land() processes
 * those files (WH-64 scope E).
 */
/** Labels as stored: trimmed, no empties or repeats (case-insensitively, first spelling wins), at most 20 of at most 40 characters. */
export const cleanDocLabels = (labels: string[]) => cleanLabels(labels, "doc");

export async function updateDoc(actor: Actor, teamRef: string, ref: string, patch: DocUpdateInput, expectedVersion?: number) {
  const db = await getDb();
  const team = await requireTeam(actor, teamRef, "edit");
  await assertDocsWritable(actor, db);
  if (patch.body !== undefined) {
    const bodyBytes = Buffer.byteLength(patch.body, "utf8");
    if (bodyBytes > DOC_BODY_MAX_BYTES) throw new ServiceError("invalid", `Doc body is ${bodyBytes} bytes; the limit is ${DOC_BODY_MAX_BYTES} (200 KB)`);
  }

  if (actor.kind === "agent" && !patch.forcePublish) {
    const existing = await resolveDoc(db, team.id, ref).catch(() => undefined);
    if (existing) {
      const { maybeDraftDoc } = await import("./sync");
      const d = await maybeDraftDoc(actor, existing, patch);
      if (d) return { ...existing, ...d };
    }
  }

  return db.transaction(async (tx) => {
    const d = await lockRow(tx, docs, await resolveDoc(tx, team.id, ref));
    if (expectedVersion !== undefined && expectedVersion !== d.version) {
      throw new ServiceError("conflict", `Doc "${d.title}" was changed (version ${d.version}, you had ${expectedVersion}). Re-read and retry.`, { current: d });
    }
    const clean: Record<string, unknown> = {};
    if (patch.title !== undefined) clean.title = patch.title.trim();
    if (patch.body !== undefined) clean.body = patch.body;
    if (patch.anchors !== undefined) clean.anchors = patch.anchors;
    if (patch.labels !== undefined) clean.labels = cleanDocLabels(patch.labels);
    const changes = diff(d as unknown as Record<string, unknown>, clean);
    // Editing title/body/anchors, or an explicit confirm (mark_doc_fresh-equivalent), clears staleness —
    // same rule as upsertNode's EXPLAINER_FIELDS/anchors/markFresh check.
    const described = "title" in changes || "body" in changes || "anchors" in changes || patch.markFresh || patch.describedSha;
    const fresh = described
      ? {
          stale: false,
          staleReason: null,
          staleSource: null,
          driftPaths: [],
          describedHashes: patch.describedHashes ?? (await landedHashesFor(tx, team.id, patch.anchors ?? d.anchors)),
          describedAt: new Date(),
          describedSha: patch.describedSha ?? d.describedSha,
        }
      : {};
    if (!Object.keys(changes).length && !described) return d;
    const [updated] = await tx
      .update(docs)
      .set({ ...clean, ...fresh, version: d.version + 1, updatedAt: new Date(), updatedByKind: actor.kind, updatedById: actor.id })
      .where(eq(docs.id, d.id))
      .returning();
    const meaningful = Object.keys(changes);
    if (meaningful.length || (d.stale && described)) {
      await emit(tx, actor, team.id, {
        type: "doc.updated",
        entity: "doc",
        entityId: updated.id,
        summary: `updated doc "${updated.title}"${meaningful.length ? `: ${meaningful.join(", ")}` : ""}${d.stale && described ? " (now fresh)" : ""}`,
        data: { slug: updated.slug, changes: meaningful },
      });
    }
    return updated;
  });
}

/** Clear a doc's stale flag after confirming it's still accurate (no edits needed) — mirrors markFresh for nodes. */
export async function markDocFresh(actor: Actor, teamRef: string, ref: string, sha?: string) {
  return updateDoc(actor, teamRef, ref, { markFresh: true, describedSha: sha });
}

/** Move a doc to a new parent and/or position among its siblings. */
export async function moveDoc(actor: Actor, teamRef: string, ref: string, opts: { parent?: string | null; index?: number }, expectedVersion?: number) {
  const db = await getDb();
  const team = await requireTeam(actor, teamRef, "edit");
  await assertDocsWritable(actor, db);
  return db.transaction(async (tx) => {
    const d = await lockRow(tx, docs, await resolveDoc(tx, team.id, ref));
    if (expectedVersion !== undefined && expectedVersion !== d.version) {
      throw new ServiceError("conflict", `Doc "${d.title}" was changed since you read it`, { current: d });
    }
    const parentId = opts.parent === undefined ? d.parentId : opts.parent === null ? null : (await resolveDoc(tx, team.id, opts.parent)).id;
    if (parentId === d.id) throw new ServiceError("invalid", "A doc cannot be its own parent");
    // Prevent cycles: the new parent can't be one of this doc's own descendants.
    if (parentId) {
      let cur: string | null = parentId;
      while (cur) {
        if (cur === d.id) throw new ServiceError("invalid", "Can't move a doc under one of its own descendants");
        const [p] = await tx.select({ parentId: docs.parentId }).from(docs).where(eq(docs.id, cur));
        cur = p?.parentId ?? null;
      }
    }
    if (parentId !== d.parentId) {
      const depth = await depthOf(tx, team.id, parentId);
      if (depth + 1 > DOC_MAX_DEPTH) throw new ServiceError("invalid", `Docs can nest at most ${DOC_MAX_DEPTH} levels deep`);
    }
    const slug = parentId !== d.parentId ? await uniqueSlug(tx, team.id, parentId, d.slug, d.id) : d.slug;
    const siblings = await tx
      .select({ id: docs.id, position: docs.position })
      .from(docs)
      .where(and(eq(docs.teamId, team.id), isNull(docs.deletedAt), parentId === null ? isNull(docs.parentId) : eq(docs.parentId, parentId), ne(docs.id, d.id)))
      .orderBy(asc(docs.position));
    const i = opts.index === undefined || opts.index < 0 || opts.index > siblings.length ? siblings.length : opts.index;
    const before = siblings[i - 1]?.position;
    const after = siblings[i]?.position;
    const position = before === undefined && after === undefined ? 1000 : before === undefined ? after! - 1000 : after === undefined ? before + 1000 : (before + after) / 2;
    const [updated] = await tx
      .update(docs)
      .set({ parentId, slug, position, version: d.version + 1, updatedAt: new Date(), updatedByKind: actor.kind, updatedById: actor.id })
      .where(eq(docs.id, d.id))
      .returning();
    await emit(tx, actor, team.id, {
      type: "doc.moved",
      entity: "doc",
      entityId: updated.id,
      summary: `moved doc "${updated.title}"`,
      data: { slug: updated.slug },
    });
    return updated;
  });
}

/** Soft delete: sets deletedAt (kept 30 days for recovery/purge); history lives in `events`. */
export async function deleteDoc(actor: Actor, teamRef: string, ref: string) {
  const db = await getDb();
  const team = await requireTeam(actor, teamRef, "edit");
  await assertDocsWritable(actor, db);
  return db.transaction(async (tx) => {
    const d = await resolveDoc(tx, team.id, ref);
    await tx.update(docs).set({ deletedAt: new Date() }).where(eq(docs.id, d.id));
    // Soft-delete descendants too, so a deleted branch doesn't linger half-visible.
    const toDelete = [d.id];
    for (let i = 0; i < toDelete.length; i++) {
      const kids = await tx.select({ id: docs.id }).from(docs).where(and(eq(docs.parentId, toDelete[i]), isNull(docs.deletedAt)));
      for (const k of kids) toDelete.push(k.id);
    }
    if (toDelete.length > 1) await tx.update(docs).set({ deletedAt: new Date() }).where(inArray(docs.id, toDelete.slice(1)));
    await emit(tx, actor, team.id, {
      type: "doc.deleted",
      entity: "doc",
      entityId: d.id,
      summary: `deleted doc "${d.title}"${toDelete.length > 1 ? ` (and ${toDelete.length - 1} nested)` : ""}`,
      data: { slug: d.slug, title: d.title },
    });
    return { ok: true };
  });
}

export async function linkDocNode(actor: Actor, teamRef: string, docRef: string, nodeRef: string, unlink = false) {
  const db = await getDb();
  const team = await requireTeam(actor, teamRef, "edit");
  await assertDocsWritable(actor, db);
  const d = await resolveDoc(db, team.id, docRef);
  const n = await resolveNode(db, team.id, nodeRef);
  if (unlink) {
    await db.delete(docNodes).where(and(eq(docNodes.docId, d.id), eq(docNodes.nodeId, n.id)));
  } else {
    await db.insert(docNodes).values({ docId: d.id, nodeId: n.id }).onConflictDoNothing();
  }
  return { ok: true };
}

/**
 * Full-text search over doc title + body, ranked by ts_rank, with snippets.
 * Computed at query time (to_tsvector('english', …)) rather than a persisted
 * generated column: kept simple and portable between the embedded PGlite used
 * in local dev/tests and real Postgres in prod (ADR: see final report).
 * `max_tokens` is approximated from characters (~4 chars/token, same rule of
 * thumb the briefing budget uses) so results fit an agent's context budget.
 */
export async function searchDocs(actor: Actor, teamRef: string, query: string, opts: { maxTokens?: number } = {}) {
  const db = await getDb();
  const team = await requireTeam(actor, teamRef);
  const q = query.trim();
  if (!q) throw new ServiceError("invalid", "query is required");
  const maxChars = Math.min(Math.max((opts.maxTokens ?? 800) * 4, 400), 80_000);

  const tsq = sql`websearch_to_tsquery('english', ${q})`;
  const vector = sql`setweight(to_tsvector('english', ${docs.title}), 'A') || setweight(to_tsvector('english', ${docs.body}), 'B')`;
  const rows = await db
    .select({
      id: docs.id,
      slug: docs.slug,
      title: docs.title,
      body: docs.body,
      updatedAt: docs.updatedAt,
      rank: sql<number>`ts_rank(${vector}, ${tsq})`,
      snippet: sql<string>`ts_headline('english', ${docs.body}, ${tsq}, 'MaxFragments=2, MinWords=5, MaxWords=25')`,
    })
    .from(docs)
    .where(and(eq(docs.teamId, team.id), isNull(docs.deletedAt), sql`${vector} @@ ${tsq}`))
    .orderBy(desc(sql`ts_rank(${vector}, ${tsq})`))
    .limit(50);

  const out: { slug: string; title: string; snippet: string; updatedAt: Date; rank: number }[] = [];
  let used = 0;
  for (const r of rows) {
    const snippet = r.snippet || clipText(r.body, 240);
    const cost = r.title.length + snippet.length + 20;
    if (used + cost > maxChars && out.length) break;
    out.push({ slug: r.slug, title: r.title, snippet, updatedAt: r.updatedAt, rank: r.rank });
    used += cost;
    if (used > maxChars) break;
  }
  return { query: q, results: out, truncated: out.length < rows.length };
}

function clipText(s: string, n: number) {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

/** Short index for the briefing: titles + slugs only, never bodies (protects the token budget). */
export async function listDocsIndex(actor: Actor, teamRef: string) {
  const db = await getDb();
  const team = await requireTeam(actor, teamRef);
  return db
    .select({ slug: docs.slug, title: docs.title, parentId: docs.parentId })
    .from(docs)
    .where(and(eq(docs.teamId, team.id), isNull(docs.deletedAt)))
    .orderBy(asc(docs.position));
}
