import { statusForRole, roleFromText, DEFAULT_STATUS_DEFS } from "@wheelhouse/shared/status-roles";
import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { getDb, schema } from "../../db";
import type { Actor } from "../../common/actor";
import { ServiceError } from "../../common/service-error";
import { cleanLabels } from "../../common/labels";
import { labelsOf, setIssueLabels, withCycle, withLabels } from "./links";
import { roleOnTeam } from "../teams/index";
import { assertWritable, type Need, roleAllows } from "../../common/roles";
import { isUuid } from "../../common/uuid";
import { Q, Tx, lockRow } from "../../platform/database/transaction";
import { diff, emit } from "../../platform/events/emit";
import { requireTeam } from "../teams/index";

export const DEFAULT_STATUSES = DEFAULT_STATUS_DEFS.map((c) => c.name);

const { teams, statuses, issues, comments, nodes, issueNodes, events, projects } = schema;

// ───────────────────────── board / issues ─────────────────────────

export type IssueWithLinks = typeof issues.$inferSelect & { ref: string; labels: string[]; cycle: number | null; nodeIds: string[]; commentCount: number };

export const CLAIM_TTL_MS = 24 * 3600e3;

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
export async function assertAssignee(q: Q, teamId: string, userId: string | null | undefined) {
  if (!userId) return;
  const [m] = isUuid(userId)
    ? await q
        .select({ userId: schema.teamMembers.userId })
        .from(schema.teamMembers)
        .where(and(eq(schema.teamMembers.teamId, teamId), eq(schema.teamMembers.userId, userId)))
    : [];
  if (!m) throw new ServiceError("invalid", "Assignee must be a member of this team");
}

export async function resolveStatus(q: Q, teamId: string, ref: string) {
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
  const { pullRequestsForIssue } = await import("../github/service");
  const pullRequests = await pullRequestsForIssue(issue.id);
  const [withLabel] = await withCycle(db, await withLabels(db, [issue]));
  const { parent, children } = await (await import("./sub-issues")).relatives(db, team, issue);
  return { issue: { ...withLabel, ref: r, status: col?.name }, team, comments: cs, nodes: linked, history, pullRequests, parent, children };
}

export async function positionAt(q: Q, statusId: string, index: number | undefined, excludeId?: string) {
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
export async function emitProjectMove(tx: Tx, actor: Actor, teamId: string, ref: string, from: string | null, to: string | null) {
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

export async function updateIssueTx(actor: Actor, ref: string, patch: IssueInput, expectedVersion?: number) {
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

export async function moveIssueTx(actor: Actor, ref: string, status: string, index?: number, expectedVersion?: number) {
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
export async function bindSession<T extends { id: string; teamId: string }>(actor: Actor, t: T): Promise<T> {
  if (actor.kind === "agent") {
    const { noteIssueActivity } = await import("../map/sync");
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
