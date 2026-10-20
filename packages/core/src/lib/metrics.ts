import { idsWithRole } from "./column-roles";
import { and, asc, desc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { getDb, schema } from "../db";
import type { Actor } from "./access";
import { roleOnTeam, visibleTeamIds } from "./team-access";
import { queueStatus } from "./service";
import type { SessionView } from "./session-buckets";

/**
 * Read-only aggregates for the dashboard. One function per widget so new
 * widgets can be added without touching the others. Everything is workspace-scoped.
 * Day buckets are UTC calendar days.
 */

const { teams, columns, issues, events, nodes, docs, apiKeys } = schema;

const DAY = 864e5;
export const dayKey = (d: Date | string) => new Date(d).toISOString().slice(0, 10);
export function lastNDays(n: number) {
  const today = new Date();
  return Array.from({ length: n }, (_, i) => dayKey(new Date(today.getTime() - (n - 1 - i) * DAY)));
}

/**
 * Per-request memoisation is the host's business: a dashboard render calls several widgets that each read the same snapshot,
 * and the Next app registers React's cache() here so they share one query. Without a host (the API, tests) every call reads
 * afresh, which is correct, just not deduplicated.
 */
type Memo = <A extends unknown[], R>(fn: (...args: A) => R) => (...args: A) => R;
let memo: Memo = (fn) => fn;
let memoised: ((workspaceId: string, viewer: string, teamId: string) => ReturnType<typeof loadSnapshot>) | null = null;
export function setRequestMemo(m: Memo) {
  memo = m;
  memoised = null;
}
/** `viewer` is the person's user id. "*" (the whole workspace) is only for callers that are not people; only people reach the dashboard, and agent keys and system actors never get here. */
const snapshot = (actor: Actor, teamId?: string) => (memoised ??= memo(loadSnapshot))(actor.workspaceId, actor.kind === "human" && !actor.system ? actor.id : "*", teamId ?? "*");

/**
 * Teams, columns, issues, recent events for one workspace, limited to the teams `viewer` can open, and to one team when
 * `teamId` is given (the caller has already resolved it through requireTeam, so it is one the viewer can open; it is
 * intersected with what they can open anyway, so a stray id yields an empty snapshot rather than someone else's numbers).
 */
const loadSnapshot = async (workspaceId: string, viewer: string, teamId: string) => {
  const db = await getDb();
  const visible = viewer === "*" ? null : await visibleTeamIds(db, { kind: "human", id: viewer, name: "", workspaceId });
  const ps = await db
    .select()
    .from(teams)
    .where(and(eq(teams.workspaceId, workspaceId), visible ? inArray(teams.id, visible) : undefined, teamId === "*" ? undefined : eq(teams.id, teamId)))
    .orderBy(asc(teams.createdAt));
  const pids = ps.map((p) => p.id);
  if (!pids.length) return { teams: ps, columns: [], issues: [], events: [], nodes: [], docs: [] };
  const [cs, ts, es, ns, ds] = await Promise.all([
    db.select().from(columns).where(inArray(columns.teamId, pids)).orderBy(asc(columns.position)),
    db.select().from(issues).where(inArray(issues.teamId, pids)),
    db
      .select()
      .from(events)
      .where(and(eq(events.workspaceId, workspaceId), inArray(events.teamId, pids), gte(events.createdAt, new Date(Date.now() - 28 * DAY))))
      .orderBy(desc(events.seq)),
    db
      .select({ id: nodes.id, teamId: nodes.teamId, name: nodes.name, layer: nodes.layer, stale: nodes.stale, staleReason: nodes.staleReason })
      .from(nodes)
      .where(inArray(nodes.teamId, pids)),
    db
      .select({ id: docs.id, teamId: docs.teamId, slug: docs.slug, title: docs.title, stale: docs.stale, staleReason: docs.staleReason })
      .from(docs)
      .where(and(inArray(docs.teamId, pids), isNull(docs.deletedAt))),
  ]);
  return { teams: ps, columns: cs, issues: ts, events: es, nodes: ns, docs: ds };
};

type Snap = Awaited<ReturnType<typeof snapshot>>;

/** Columns are found by role (WH-86), so renaming one changes nothing here. */
function columnRoles(s: Snap) {
  const byTeam = new Map<string, Snap["columns"]>();
  for (const c of s.columns) byTeam.set(c.teamId, [...(byTeam.get(c.teamId) ?? []), c]);
  return { byTeam, doneIds: idsWithRole(s.columns, "done"), inProgress: idsWithRole(s.columns, "in_progress"), review: idsWithRole(s.columns, "review") };
}

/** Moves into a team's done column, from the event log. Older events only recorded the column's name. */
function completions(s: Snap) {
  const doneNames = new Map<string, Set<string>>();
  for (const c of s.columns) if (c.role === "done") doneNames.set(c.teamId, (doneNames.get(c.teamId) ?? new Set()).add(c.name));
  return s.events.filter((e) => e.type === "issue.moved" && (e.data?.toRole ? e.data.toRole === "done" : doneNames.get(e.teamId)?.has(String(e.data?.to)) ?? false));
}

// ───────── widgets ─────────

export async function summary(actor: Actor, teamId?: string) {
  const s = await snapshot(actor, teamId);
  const roles = columnRoles(s);
  const open = s.issues.filter((t) => !roles.doneIds.has(t.columnId));
  const now = Date.now();
  const within = (d: Date, from: number, to: number) => {
    const age = now - new Date(d).getTime();
    return age >= from * DAY && age < to * DAY;
  };
  const comp = completions(s);
  const thisWeek = comp.filter((e) => within(e.createdAt, 0, 7)).length;
  const lastWeek = comp.filter((e) => within(e.createdAt, 7, 14)).length;
  const week = s.events.filter((e) => within(e.createdAt, 0, 7));
  const agentEvents = week.filter((e) => e.actorKind === "agent").length;

  const db = await getDb();
  const keys = await db.select({ id: apiKeys.id }).from(apiKeys).where(and(eq(apiKeys.workspaceId, actor.workspaceId), isNull(apiKeys.revokedAt)));

  return {
    teams: s.teams.length,
    open: open.length,
    inProgress: open.filter((t) => roles.inProgress.has(t.columnId)).length,
    inReview: open.filter((t) => roles.review.has(t.columnId)).length,
    completed7d: thisWeek,
    completedPrev7d: lastWeek,
    agentShare7d: week.length ? agentEvents / week.length : null,
    events7d: week.length,
    staleNodes: s.nodes.filter((n) => n.stale).length,
    mapNodes: s.nodes.length,
    staleDocs: s.docs.filter((d) => d.stale).length,
    agents: keys.length,
    /** Different agents (API keys) that changed something in these teams in the last 7 days. */
    agentsActive7d: new Set(week.filter((e) => e.actorKind === "agent").map((e) => e.actorId)).size,
  };
}

export async function teamProgress(actor: Actor, teamId?: string) {
  const s = await snapshot(actor, teamId);
  const roles = columnRoles(s);
  return s.teams.map((p) => {
    const cols = roles.byTeam.get(p.id) ?? [];
    const ts = s.issues.filter((t) => t.teamId === p.id);
    const stages = cols.map((c) => ({ id: c.id, name: c.name, count: ts.filter((t) => t.columnId === c.id).length }));
    const done = ts.filter((t) => roles.doneIds.has(t.columnId)).length;
    const lastEvent = s.events.find((e) => e.teamId === p.id);
    const open = ts.filter((t) => !roles.doneIds.has(t.columnId));
    return {
      id: p.id,
      key: p.key,
      name: p.name,
      total: ts.length,
      done,
      pct: ts.length ? done / ts.length : 0,
      stages,
      urgent: open.filter((t) => t.priority === "urgent" || t.priority === "high").length,
      agentReady: open.filter((t) => t.agentClaimable && !t.claimedByKeyId).length,
      staleNodes: s.nodes.filter((n) => n.teamId === p.id && n.stale).length,
      mapNodes: s.nodes.filter((n) => n.teamId === p.id).length,
      staleDocs: s.docs.filter((d) => d.teamId === p.id && d.stale).length,
      lastActivity: lastEvent?.createdAt ?? null,
    };
  });
}

/** Issues created vs completed per day. */
export async function throughput(actor: Actor, days = 14, teamId?: string) {
  const s = await snapshot(actor, teamId);
  const keys = lastNDays(days);
  const created = new Map<string, number>();
  const completed = new Map<string, number>();
  for (const e of s.events) if (e.type === "issue.created") created.set(dayKey(e.createdAt), (created.get(dayKey(e.createdAt)) ?? 0) + 1);
  for (const e of completions(s)) completed.set(dayKey(e.createdAt), (completed.get(dayKey(e.createdAt)) ?? 0) + 1);
  return keys.map((day) => ({ day, created: created.get(day) ?? 0, completed: completed.get(day) ?? 0 }));
}

/** All changes per day, split by who made them. */
export async function activityByActor(actor: Actor, days = 14, teamId?: string) {
  const s = await snapshot(actor, teamId);
  const keys = lastNDays(days);
  const rows = new Map(keys.map((k) => [k, { day: k, human: 0, agent: 0 }]));
  for (const e of s.events) {
    const r = rows.get(dayKey(e.createdAt));
    if (r) r[e.actorKind]++;
  }
  return [...rows.values()];
}

export async function agentQueues(actor: Actor, teamId?: string) {
  const s = await snapshot(actor, teamId);
  const db = await getDb();
  const keys = await db
    .select({ id: apiKeys.id, name: apiKeys.name, lastUsedAt: apiKeys.lastUsedAt })
    .from(apiKeys)
    .where(and(eq(apiKeys.workspaceId, actor.workspaceId), isNull(apiKeys.revokedAt)))
    .orderBy(desc(apiKeys.lastUsedAt));
  const pending = new Map<string, { total: number; byTeam: { key: string; pending: number }[]; sessions: SessionView[] }>();
  for (const p of s.teams) {
    for (const q of await queueStatus(actor, p.id)) {
      const cur = pending.get(q.id) ?? { total: 0, byTeam: [], sessions: [] };
      cur.total += q.pending;
      if (q.pending) cur.byTeam.push({ key: p.key, pending: q.pending });
      for (const x of q.sessions) cur.sessions.push({ ...x, lastSeenAt: x.lastSeenAt.toISOString(), teamKey: p.key });
      pending.set(q.id, cur);
    }
  }
  const week = s.events.filter((e) => e.actorKind === "agent" && Date.now() - new Date(e.createdAt).getTime() < 7 * DAY);
  const rows = keys.map((k) => ({
    ...k,
    pending: pending.get(k.id)?.total ?? 0,
    byTeam: pending.get(k.id)?.byTeam ?? [],
    sessions: (pending.get(k.id)?.sessions ?? []).sort((x, y) => y.lastSeenAt.localeCompare(x.lastSeenAt)),
    actions7d: week.filter((e) => e.actorId === k.id).length,
  }));
  // For one team, only the agents that do something there: a workspace has keys that never touch this team.
  return teamId ? rows.filter((r) => r.pending > 0 || r.actions7d > 0 || r.sessions.length > 0) : rows;
}

/** Things a human should look at: review queue, urgent work, stale explanations. */
export async function needsAttention(actor: Actor, teamId?: string) {
  const s = await snapshot(actor, teamId);
  const roles = columnRoles(s);
  const pkey = new Map(s.teams.map((p) => [p.id, p.key]));
  const doneIds = roles.doneIds;
  const ref = (t: Snap["issues"][number]) => `${pkey.get(t.teamId)}-${t.number}`;
  const byUpdated = (a: { updatedAt: Date }, b: { updatedAt: Date }) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  const review = s.issues
    .filter((t) => roles.review.has(t.columnId))
    .sort(byUpdated)
    .slice(0, 6)
    .map((t) => ({ ref: ref(t), title: t.title, teamKey: pkey.get(t.teamId)!, byAgent: t.createdByKind === "agent" || !!t.claimedByKeyId, updatedAt: t.updatedAt }));
  const urgent = s.issues
    .filter((t) => !doneIds.has(t.columnId) && t.priority === "urgent")
    .sort(byUpdated)
    .slice(0, 6)
    .map((t) => ({ ref: ref(t), title: t.title, teamKey: pkey.get(t.teamId)!, column: s.columns.find((c) => c.id === t.columnId)?.name ?? "" }));
  const stale = s.nodes
    .filter((n) => n.stale)
    .slice(0, 6)
    .map((n) => ({ id: n.id, name: n.name, layer: n.layer, reason: n.staleReason, teamKey: pkey.get(n.teamId)! }));
  const staleDocs = s.docs
    .filter((d) => d.stale)
    .slice(0, 6)
    .map((d) => ({ id: d.id, slug: d.slug, title: d.title, reason: d.staleReason, teamKey: pkey.get(d.teamId)! }));
  return { review, urgent, stale, staleDocs };
}

export async function recentActivity(actor: Actor, limit = 12, teamId?: string) {
  const s = await snapshot(actor, teamId);
  const pkey = new Map(s.teams.map((p) => [p.id, p.key]));
  return s.events.slice(0, limit).map((e) => ({ ...e, teamKey: pkey.get(e.teamId) ?? "?" }));
}

/**
 * Sync health: where the board/map are drifting from real work.
 * - work in flux with no issue bound to the session
 * - agent-claimed issues with no activity from that agent for a while
 * - map drafts waiting for their code to land
 */
export async function syncHealth(actor: Actor, teamId?: string) {
  const s = await snapshot(actor, teamId);
  const db = await getDb();
  const pids = s.teams.map((p) => p.id);
  if (!pids.length) return { untracked: [], quiet: [], drafts: [] };
  const pkey = new Map(s.teams.map((p) => [p.id, p.key]));
  const roles = columnRoles(s);
  const doneIds = roles.doneIds;

  const sessions = await db
    .select()
    .from(schema.workSessions)
    .where(and(inArray(schema.workSessions.teamId, pids), isNull(schema.workSessions.endedAt), gte(schema.workSessions.lastSeenAt, new Date(Date.now() - 12 * 3600e3))));
  const untracked = sessions
    .map((x) => ({ ...x, own: Object.entries(x.files).filter(([, f]) => !f.external).map(([p]) => p) }))
    .filter((x) => x.own.length && !x.issueId)
    .map((x) => ({ id: x.id, teamKey: pkey.get(x.teamId)!, by: x.actorName, files: x.own, since: x.firstChangeAt ?? x.startedAt }));

  const QUIET_MS = 2 * 3600e3;
  const keys = await db.select({ id: apiKeys.id, name: apiKeys.name }).from(apiKeys).where(eq(apiKeys.workspaceId, actor.workspaceId));
  const keyName = new Map(keys.map((k) => [k.id, k.name]));
  const quiet = s.issues
    .filter((t) => t.claimedByKeyId && !doneIds.has(t.columnId))
    .map((t) => {
      const last = s.events.find((e) => e.entityId === t.id && e.actorId === t.claimedByKeyId);
      const lastAt = last ? new Date(last.createdAt).getTime() : new Date(t.updatedAt).getTime();
      return { t, lastAt };
    })
    .filter((x) => Date.now() - x.lastAt > QUIET_MS)
    .map(({ t, lastAt }) => ({
      ref: `${pkey.get(t.teamId)}-${t.number}`,
      title: t.title,
      teamKey: pkey.get(t.teamId)!,
      agent: keyName.get(t.claimedByKeyId!) ?? "agent",
      lastAt: new Date(lastAt),
    }));

  const pending = await db
    .select({ id: schema.nodeDrafts.id, teamId: schema.nodeDrafts.teamId, nodeId: schema.nodeDrafts.nodeId, authorName: schema.nodeDrafts.authorName, confirm: schema.nodeDrafts.confirm, createdAt: schema.nodeDrafts.createdAt })
    .from(schema.nodeDrafts)
    .where(and(inArray(schema.nodeDrafts.teamId, pids), eq(schema.nodeDrafts.status, "pending")));
  const nodeName = new Map(s.nodes.map((n) => [n.id, `${n.layer}:${n.name}`]));
  const drafts = pending.map((d) => ({ ...d, teamKey: pkey.get(d.teamId)!, node: nodeName.get(d.nodeId) ?? "?" }));
  return { untracked, quiet, drafts };
}

/**
 * The most important things about ONE team, ranked for a quick look: work that has sat longest in progress, what has waited
 * longest for review, agents that claimed an issue and went quiet, decisions still only proposed, and who is in the team.
 * "How long" is time since the issue last moved into its current column (from the event log; an issue that has not moved in the
 * 28 days the snapshot reads is dated from its last update, which is never later than when it moved).
 */
export async function teamFocus(actor: Actor, teamId: string) {
  const s = await snapshot(actor, teamId);
  const p = s.teams[0];
  if (!p) return { aging: [], waitingReview: [], quiet: [], proposedDecisions: 0, members: { count: 0, myRole: null as null | string }, issues: 0 };
  const roles = columnRoles(s);
  const now = Date.now();
  const colName = new Map(s.columns.map((c) => [c.id, c.name]));
  const since = (t: Snap["issues"][number]) => {
    const moved = s.events.find((e) => e.entityId === t.id && e.type === "issue.moved");
    return new Date(moved?.createdAt ?? t.updatedAt).getTime();
  };
  const row = (t: Snap["issues"][number]) => ({
    ref: `${p.key}-${t.number}`,
    title: t.title,
    column: colName.get(t.columnId) ?? "",
    priority: t.priority,
    days: Math.max(0, Math.floor((now - since(t)) / DAY)),
    byAgent: !!t.claimedByKeyId,
  });
  const oldestFirst = (a: { days: number }, b: { days: number }) => b.days - a.days;
  const aging = s.issues.filter((t) => roles.inProgress.has(t.columnId)).map(row).sort(oldestFirst).slice(0, 5);
  const waitingReview = s.issues.filter((t) => roles.review.has(t.columnId)).map(row).sort(oldestFirst).slice(0, 5);

  const db = await getDb();
  const [{ n: proposed }] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.decisions).where(and(eq(schema.decisions.teamId, p.id), eq(schema.decisions.status, "proposed")));
  const [{ n: members }] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.teamMembers).where(eq(schema.teamMembers.teamId, p.id));
  const sync = await syncHealth(actor, teamId);
  return {
    aging,
    waitingReview,
    quiet: sync.quiet.slice(0, 5),
    proposedDecisions: Number(proposed),
    members: { count: Number(members), myRole: await roleOnTeam(db, actor, p.id) },
    issues: s.issues.length,
  };
}
