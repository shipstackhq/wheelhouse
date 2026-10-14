import "server-only";
import { cache } from "react";
import { and, asc, desc, eq, gte, inArray, isNull } from "drizzle-orm";
import { getDb, schema } from "@/db";
import type { Actor } from "./auth";
import { queueStatus } from "./service";
import type { SessionView } from "@/components/session-row";

/**
 * Read-only aggregates for the dashboard. One function per widget so new
 * widgets can be added without touching the others. Everything is team-scoped.
 * Day buckets are UTC calendar days.
 */

const { projects, columns, tickets, events, nodes, apiKeys } = schema;

const DAY = 864e5;
export const dayKey = (d: Date | string) => new Date(d).toISOString().slice(0, 10);
export function lastNDays(n: number) {
  const today = new Date();
  return Array.from({ length: n }, (_, i) => dayKey(new Date(today.getTime() - (n - 1 - i) * DAY)));
}

/** Shared per-request snapshot: projects, columns, tickets, recent events. Deduped with React cache(). */
const snapshot = cache(async (teamId: string) => {
  const db = await getDb();
  const ps = await db.select().from(projects).where(eq(projects.teamId, teamId)).orderBy(asc(projects.createdAt));
  const pids = ps.map((p) => p.id);
  if (!pids.length) return { projects: ps, columns: [], tickets: [], events: [], nodes: [] };
  const [cs, ts, es, ns] = await Promise.all([
    db.select().from(columns).where(inArray(columns.projectId, pids)).orderBy(asc(columns.position)),
    db.select().from(tickets).where(inArray(tickets.projectId, pids)),
    db
      .select()
      .from(events)
      .where(and(eq(events.teamId, teamId), gte(events.createdAt, new Date(Date.now() - 28 * DAY))))
      .orderBy(desc(events.seq)),
    db
      .select({ id: nodes.id, projectId: nodes.projectId, name: nodes.name, layer: nodes.layer, stale: nodes.stale, staleReason: nodes.staleReason })
      .from(nodes)
      .where(inArray(nodes.projectId, pids)),
  ]);
  return { projects: ps, columns: cs, tickets: ts, events: es, nodes: ns };
});

type Snap = Awaited<ReturnType<typeof snapshot>>;

/** The last column (by position) counts as "done"; a column named "In Progress"/"Review" is matched by name. */
function columnRoles(s: Snap) {
  const byProject = new Map<string, Snap["columns"]>();
  for (const c of s.columns) byProject.set(c.projectId, [...(byProject.get(c.projectId) ?? []), c]);
  const done = new Map<string, Snap["columns"][number]>();
  for (const [pid, cs] of byProject) done.set(pid, cs[cs.length - 1]);
  const named = (name: string) => new Set(s.columns.filter((c) => c.name.toLowerCase() === name).map((c) => c.id));
  return { byProject, done, inProgress: named("in progress"), review: named("review") };
}

/** Moves into a project's done column, from the event log. */
function completions(s: Snap) {
  const { done } = columnRoles(s);
  return s.events.filter((e) => e.type === "ticket.moved" && e.data?.to === done.get(e.projectId)?.name);
}

// ───────── widgets ─────────

export async function summary(actor: Actor) {
  const s = await snapshot(actor.teamId);
  const roles = columnRoles(s);
  const doneIds = new Set([...roles.done.values()].map((c) => c.id));
  const open = s.tickets.filter((t) => !doneIds.has(t.columnId));
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
  const keys = await db.select({ id: apiKeys.id }).from(apiKeys).where(and(eq(apiKeys.teamId, actor.teamId), isNull(apiKeys.revokedAt)));

  return {
    projects: s.projects.length,
    open: open.length,
    inProgress: open.filter((t) => roles.inProgress.has(t.columnId)).length,
    inReview: open.filter((t) => roles.review.has(t.columnId)).length,
    completed7d: thisWeek,
    completedPrev7d: lastWeek,
    agentShare7d: week.length ? agentEvents / week.length : null,
    events7d: week.length,
    staleNodes: s.nodes.filter((n) => n.stale).length,
    mapNodes: s.nodes.length,
    agents: keys.length,
  };
}

export async function projectProgress(actor: Actor) {
  const s = await snapshot(actor.teamId);
  const roles = columnRoles(s);
  return s.projects.map((p) => {
    const cols = roles.byProject.get(p.id) ?? [];
    const ts = s.tickets.filter((t) => t.projectId === p.id);
    const doneCol = roles.done.get(p.id);
    const stages = cols.map((c) => ({ id: c.id, name: c.name, count: ts.filter((t) => t.columnId === c.id).length }));
    const done = stages.find((x) => x.id === doneCol?.id)?.count ?? 0;
    const lastEvent = s.events.find((e) => e.projectId === p.id);
    const open = ts.filter((t) => t.columnId !== doneCol?.id);
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
      staleNodes: s.nodes.filter((n) => n.projectId === p.id && n.stale).length,
      mapNodes: s.nodes.filter((n) => n.projectId === p.id).length,
      lastActivity: lastEvent?.createdAt ?? null,
    };
  });
}

/** Tickets created vs completed per day. */
export async function throughput(actor: Actor, days = 14) {
  const s = await snapshot(actor.teamId);
  const keys = lastNDays(days);
  const created = new Map<string, number>();
  const completed = new Map<string, number>();
  for (const e of s.events) if (e.type === "ticket.created") created.set(dayKey(e.createdAt), (created.get(dayKey(e.createdAt)) ?? 0) + 1);
  for (const e of completions(s)) completed.set(dayKey(e.createdAt), (completed.get(dayKey(e.createdAt)) ?? 0) + 1);
  return keys.map((day) => ({ day, created: created.get(day) ?? 0, completed: completed.get(day) ?? 0 }));
}

/** All changes per day, split by who made them. */
export async function activityByActor(actor: Actor, days = 14) {
  const s = await snapshot(actor.teamId);
  const keys = lastNDays(days);
  const rows = new Map(keys.map((k) => [k, { day: k, human: 0, agent: 0 }]));
  for (const e of s.events) {
    const r = rows.get(dayKey(e.createdAt));
    if (r) r[e.actorKind]++;
  }
  return [...rows.values()];
}

export async function agentQueues(actor: Actor) {
  const s = await snapshot(actor.teamId);
  const db = await getDb();
  const keys = await db
    .select({ id: apiKeys.id, name: apiKeys.name, lastUsedAt: apiKeys.lastUsedAt })
    .from(apiKeys)
    .where(and(eq(apiKeys.teamId, actor.teamId), isNull(apiKeys.revokedAt)))
    .orderBy(desc(apiKeys.lastUsedAt));
  const pending = new Map<string, { total: number; byProject: { key: string; pending: number }[]; sessions: SessionView[] }>();
  for (const p of s.projects) {
    for (const q of await queueStatus(actor, p.id)) {
      const cur = pending.get(q.id) ?? { total: 0, byProject: [], sessions: [] };
      cur.total += q.pending;
      if (q.pending) cur.byProject.push({ key: p.key, pending: q.pending });
      for (const x of q.sessions) cur.sessions.push({ ...x, lastSeenAt: x.lastSeenAt.toISOString(), projectKey: p.key });
      pending.set(q.id, cur);
    }
  }
  const week = s.events.filter((e) => e.actorKind === "agent" && Date.now() - new Date(e.createdAt).getTime() < 7 * DAY);
  return keys.map((k) => ({
    ...k,
    pending: pending.get(k.id)?.total ?? 0,
    byProject: pending.get(k.id)?.byProject ?? [],
    sessions: (pending.get(k.id)?.sessions ?? []).sort((x, y) => y.lastSeenAt.localeCompare(x.lastSeenAt)),
    actions7d: week.filter((e) => e.actorId === k.id).length,
  }));
}

/** Things a human should look at: review queue, urgent work, stale explanations. */
export async function needsAttention(actor: Actor) {
  const s = await snapshot(actor.teamId);
  const roles = columnRoles(s);
  const pkey = new Map(s.projects.map((p) => [p.id, p.key]));
  const doneIds = new Set([...roles.done.values()].map((c) => c.id));
  const ref = (t: Snap["tickets"][number]) => `${pkey.get(t.projectId)}-${t.number}`;
  const byUpdated = (a: { updatedAt: Date }, b: { updatedAt: Date }) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  const review = s.tickets
    .filter((t) => roles.review.has(t.columnId))
    .sort(byUpdated)
    .slice(0, 6)
    .map((t) => ({ ref: ref(t), title: t.title, projectKey: pkey.get(t.projectId)!, byAgent: t.createdByKind === "agent" || !!t.claimedByKeyId, updatedAt: t.updatedAt }));
  const urgent = s.tickets
    .filter((t) => !doneIds.has(t.columnId) && t.priority === "urgent")
    .sort(byUpdated)
    .slice(0, 6)
    .map((t) => ({ ref: ref(t), title: t.title, projectKey: pkey.get(t.projectId)!, column: s.columns.find((c) => c.id === t.columnId)?.name ?? "" }));
  const stale = s.nodes
    .filter((n) => n.stale)
    .slice(0, 6)
    .map((n) => ({ id: n.id, name: n.name, layer: n.layer, reason: n.staleReason, projectKey: pkey.get(n.projectId)! }));
  return { review, urgent, stale };
}

export async function recentActivity(actor: Actor, limit = 12) {
  const s = await snapshot(actor.teamId);
  const pkey = new Map(s.projects.map((p) => [p.id, p.key]));
  return s.events.slice(0, limit).map((e) => ({ ...e, projectKey: pkey.get(e.projectId) ?? "?" }));
}

/**
 * Sync health: where the board/map are drifting from real work.
 * - work in flux with no ticket bound to the session
 * - agent-claimed tickets with no activity from that agent for a while
 * - map drafts waiting for their code to land
 */
export async function syncHealth(actor: Actor) {
  const s = await snapshot(actor.teamId);
  const db = await getDb();
  const pids = s.projects.map((p) => p.id);
  if (!pids.length) return { untracked: [], quiet: [], drafts: [] };
  const pkey = new Map(s.projects.map((p) => [p.id, p.key]));
  const roles = columnRoles(s);
  const doneIds = new Set([...roles.done.values()].map((c) => c.id));

  const sessions = await db
    .select()
    .from(schema.workSessions)
    .where(and(inArray(schema.workSessions.projectId, pids), isNull(schema.workSessions.endedAt), gte(schema.workSessions.lastSeenAt, new Date(Date.now() - 12 * 3600e3))));
  const untracked = sessions
    .map((x) => ({ ...x, own: Object.entries(x.files).filter(([, f]) => !f.external).map(([p]) => p) }))
    .filter((x) => x.own.length && !x.ticketId)
    .map((x) => ({ id: x.id, projectKey: pkey.get(x.projectId)!, by: x.actorName, files: x.own, since: x.firstChangeAt ?? x.startedAt }));

  const QUIET_MS = 2 * 3600e3;
  const keys = await db.select({ id: apiKeys.id, name: apiKeys.name }).from(apiKeys).where(eq(apiKeys.teamId, actor.teamId));
  const keyName = new Map(keys.map((k) => [k.id, k.name]));
  const quiet = s.tickets
    .filter((t) => t.claimedByKeyId && !doneIds.has(t.columnId))
    .map((t) => {
      const last = s.events.find((e) => e.entityId === t.id && e.actorId === t.claimedByKeyId);
      const lastAt = last ? new Date(last.createdAt).getTime() : new Date(t.updatedAt).getTime();
      return { t, lastAt };
    })
    .filter((x) => Date.now() - x.lastAt > QUIET_MS)
    .map(({ t, lastAt }) => ({
      ref: `${pkey.get(t.projectId)}-${t.number}`,
      title: t.title,
      projectKey: pkey.get(t.projectId)!,
      agent: keyName.get(t.claimedByKeyId!) ?? "agent",
      lastAt: new Date(lastAt),
    }));

  const pending = await db
    .select({ id: schema.nodeDrafts.id, projectId: schema.nodeDrafts.projectId, nodeId: schema.nodeDrafts.nodeId, authorName: schema.nodeDrafts.authorName, confirm: schema.nodeDrafts.confirm, createdAt: schema.nodeDrafts.createdAt })
    .from(schema.nodeDrafts)
    .where(and(inArray(schema.nodeDrafts.projectId, pids), eq(schema.nodeDrafts.status, "pending")));
  const nodeName = new Map(s.nodes.map((n) => [n.id, `${n.layer}:${n.name}`]));
  const drafts = pending.map((d) => ({ ...d, projectKey: pkey.get(d.projectId)!, node: nodeName.get(d.nodeId) ?? "?" }));
  return { untracked, quiet, drafts };
}
