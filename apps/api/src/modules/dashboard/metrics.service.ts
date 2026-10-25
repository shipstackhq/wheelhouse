import { CLOSED_ROLES, idsWithRole, idsWithRoles } from "@wheelhouse/shared/status-roles";
import { Inject, Injectable } from "@nestjs/common";
import type { SessionView } from "@wheelhouse/shared/session-buckets";
import type { Actor } from "../../common/actor";
import { queueStatus } from "../../lib/service-queue";
import { TeamAccessService } from "../teams/index";
import { DashboardRepository } from "./dashboard.repository";

/**
 * Read-only aggregates for the dashboard. One function per widget so new
 * widgets can be added without touching the others. Everything is workspace-scoped.
 * Day buckets are UTC calendar days.
 */

const DAY = 864e5;
export const dayKey = (d: Date | string) => new Date(d).toISOString().slice(0, 10);
export function lastNDays(n: number) {
  const today = new Date();
  return Array.from({ length: n }, (_, i) => dayKey(new Date(today.getTime() - (n - 1 - i) * DAY)));
}

type Snap = Awaited<ReturnType<DashboardRepository["snapshot"]>>;

/** Statuses are found by role (WH-86), so renaming one changes nothing here. */
function statusRoles(s: Snap) {
  const byTeam = new Map<string, Snap["statuses"]>();
  for (const c of s.statuses) byTeam.set(c.teamId, [...(byTeam.get(c.teamId) ?? []), c]);
  return { byTeam, doneIds: idsWithRole(s.statuses, "done"), closedIds: idsWithRoles(s.statuses, ...CLOSED_ROLES), canceledIds: idsWithRole(s.statuses, "canceled"), inProgress: idsWithRole(s.statuses, "in_progress"), review: idsWithRole(s.statuses, "review") };
}

/** Moves into a team's done status, from the event log. Older events only recorded the status's name. */
function completions(s: Snap) {
  const doneNames = new Map<string, Set<string>>();
  for (const c of s.statuses) if (c.role === "done") doneNames.set(c.teamId, (doneNames.get(c.teamId) ?? new Set()).add(c.name));
  return s.events.filter((e) => e.type === "issue.moved" && (e.data?.toRole ? e.data.toRole === "done" : doneNames.get(e.teamId)?.has(String(e.data?.to)) ?? false));
}

/** `viewer` is the person's user id. "*" (the whole workspace) is only for callers that are not people; only people reach the dashboard, and agent keys and system actors never get here. */
@Injectable()
export class MetricsService {
  constructor(
    @Inject(DashboardRepository) private readonly repo: DashboardRepository,
    @Inject(TeamAccessService) private readonly access: TeamAccessService,
  ) {}

  /**
   * Teams, statuses, issues, recent events for one workspace, limited to the teams the person can open, and to one team when
   * `teamId` is given (the caller has already resolved it through TeamAccessService, so it is one the viewer can open; it is
   * intersected with what they can open anyway, so a stray id yields an empty snapshot rather than someone else's numbers).
   */
  private async snapshot(actor: Actor, teamId?: string) {
    const viewer = actor.kind === "human" && !actor.system ? actor.id : "*";
    const visible = viewer === "*" ? null : await this.access.visibleTeamIds({ kind: "human", id: viewer, name: "", workspaceId: actor.workspaceId });
    return this.repo.snapshot(actor.workspaceId, visible, teamId ?? "*");
  }

  // ───────── widgets ─────────

  async summary(actor: Actor, teamId?: string) {
    const s = await this.snapshot(actor, teamId);
    const roles = statusRoles(s);
    const open = s.issues.filter((t) => !roles.closedIds.has(t.statusId));
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

    const keys = await this.repo.activeKeys(actor.workspaceId);

    return {
      teams: s.teams.length,
      open: open.length,
      inProgress: open.filter((t) => roles.inProgress.has(t.statusId)).length,
      inReview: open.filter((t) => roles.review.has(t.statusId)).length,
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

  async teamProgress(actor: Actor, teamId?: string) {
    const s = await this.snapshot(actor, teamId);
    const roles = statusRoles(s);
    return s.teams.map((p) => {
      const cols = roles.byTeam.get(p.id) ?? [];
      const ts = s.issues.filter((t) => t.teamId === p.id);
      const stages = cols.map((c) => ({ id: c.id, name: c.name, count: ts.filter((t) => t.statusId === c.id).length }));
      // A canceled issue is out of the team's scope: it is neither done nor still to do.
      const scope = ts.filter((t) => !roles.canceledIds.has(t.statusId));
      const done = scope.filter((t) => roles.doneIds.has(t.statusId)).length;
      const lastEvent = s.events.find((e) => e.teamId === p.id);
      const open = ts.filter((t) => !roles.closedIds.has(t.statusId));
      return {
        id: p.id,
        key: p.key,
        name: p.name,
        total: scope.length,
        done,
        pct: scope.length ? done / scope.length : 0,
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
  async throughput(actor: Actor, days = 14, teamId?: string) {
    const s = await this.snapshot(actor, teamId);
    const keys = lastNDays(days);
    const created = new Map<string, number>();
    const completed = new Map<string, number>();
    for (const e of s.events) if (e.type === "issue.created") created.set(dayKey(e.createdAt), (created.get(dayKey(e.createdAt)) ?? 0) + 1);
    for (const e of completions(s)) completed.set(dayKey(e.createdAt), (completed.get(dayKey(e.createdAt)) ?? 0) + 1);
    return keys.map((day) => ({ day, created: created.get(day) ?? 0, completed: completed.get(day) ?? 0 }));
  }

  /** All changes per day, split by who made them. */
  async activityByActor(actor: Actor, days = 14, teamId?: string) {
    const s = await this.snapshot(actor, teamId);
    const keys = lastNDays(days);
    const rows = new Map(keys.map((k) => [k, { day: k, human: 0, agent: 0 }]));
    for (const e of s.events) {
      const r = rows.get(dayKey(e.createdAt));
      if (r) r[e.actorKind]++;
    }
    return [...rows.values()];
  }

  async agentQueues(actor: Actor, teamId?: string) {
    const s = await this.snapshot(actor, teamId);
    const keys = await this.repo.activeKeys(actor.workspaceId);
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
  async needsAttention(actor: Actor, teamId?: string) {
    const s = await this.snapshot(actor, teamId);
    const roles = statusRoles(s);
    const pkey = new Map(s.teams.map((p) => [p.id, p.key]));
    const closedIds = roles.closedIds;
    const ref = (t: Snap["issues"][number]) => `${pkey.get(t.teamId)}-${t.number}`;
    const byUpdated = (a: { updatedAt: Date }, b: { updatedAt: Date }) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    const review = s.issues
      .filter((t) => roles.review.has(t.statusId))
      .sort(byUpdated)
      .slice(0, 6)
      .map((t) => ({ ref: ref(t), title: t.title, teamKey: pkey.get(t.teamId)!, byAgent: t.createdByKind === "agent" || !!t.claimedByKeyId, updatedAt: t.updatedAt }));
    const urgent = s.issues
      .filter((t) => !closedIds.has(t.statusId) && t.priority === "urgent")
      .sort(byUpdated)
      .slice(0, 6)
      .map((t) => ({ ref: ref(t), title: t.title, teamKey: pkey.get(t.teamId)!, status: s.statuses.find((c) => c.id === t.statusId)?.name ?? "" }));
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

  async recentActivity(actor: Actor, limit = 12, teamId?: string) {
    const s = await this.snapshot(actor, teamId);
    const pkey = new Map(s.teams.map((p) => [p.id, p.key]));
    return s.events.slice(0, limit).map((e) => ({ ...e, teamKey: pkey.get(e.teamId) ?? "?" }));
  }

  /**
   * Sync health: where the board/map are drifting from real work.
   * - work in flux with no issue bound to the session
   * - agent-claimed issues with no activity from that agent for a while
   * - map drafts waiting for their code to land
   */
  async syncHealth(actor: Actor, teamId?: string) {
    const s = await this.snapshot(actor, teamId);
    const pids = s.teams.map((p) => p.id);
    if (!pids.length) return { untracked: [], quiet: [], drafts: [] };
    const pkey = new Map(s.teams.map((p) => [p.id, p.key]));
    const roles = statusRoles(s);
    const closedIds = roles.closedIds;

    const sessions = await this.repo.activeSessions(pids, 12 * 3600e3);
    const untracked = sessions
      .map((x) => ({ ...x, own: Object.entries(x.files).filter(([, f]) => !f.external).map(([p]) => p) }))
      .filter((x) => x.own.length && !x.issueId)
      .map((x) => ({ id: x.id, teamKey: pkey.get(x.teamId)!, by: x.actorName, files: x.own, since: x.firstChangeAt ?? x.startedAt }));

    const QUIET_MS = 2 * 3600e3;
    const keys = await this.repo.keyNames(actor.workspaceId);
    const keyName = new Map(keys.map((k) => [k.id, k.name]));
    const quiet = s.issues
      .filter((t) => t.claimedByKeyId && !closedIds.has(t.statusId))
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

    const pending = await this.repo.pendingNodeDrafts(pids);
    const nodeName = new Map(s.nodes.map((n) => [n.id, `${n.layer}:${n.name}`]));
    const drafts = pending.map((d) => ({ ...d, teamKey: pkey.get(d.teamId)!, node: nodeName.get(d.nodeId) ?? "?" }));
    return { untracked, quiet, drafts };
  }

  /**
   * The most important things about ONE team, ranked for a quick look: work that has sat longest in progress, what has waited
   * longest for review, agents that claimed an issue and went quiet, decisions still only proposed, and who is in the team.
   * "How long" is time since the issue last moved into its current status (from the event log; an issue that has not moved in the
   * 28 days the snapshot reads is dated from its last update, which is never later than when it moved).
   */
  async teamFocus(actor: Actor, teamId: string) {
    const s = await this.snapshot(actor, teamId);
    const p = s.teams[0];
    if (!p) return { aging: [], waitingReview: [], quiet: [], proposedDecisions: 0, members: { count: 0, myRole: null as null | string }, issues: 0 };
    const roles = statusRoles(s);
    const now = Date.now();
    const colName = new Map(s.statuses.map((c) => [c.id, c.name]));
    const since = (t: Snap["issues"][number]) => {
      const moved = s.events.find((e) => e.entityId === t.id && e.type === "issue.moved");
      return new Date(moved?.createdAt ?? t.updatedAt).getTime();
    };
    const row = (t: Snap["issues"][number]) => ({
      ref: `${p.key}-${t.number}`,
      title: t.title,
      status: colName.get(t.statusId) ?? "",
      priority: t.priority,
      days: Math.max(0, Math.floor((now - since(t)) / DAY)),
      byAgent: !!t.claimedByKeyId,
    });
    const oldestFirst = (a: { days: number }, b: { days: number }) => b.days - a.days;
    const aging = s.issues.filter((t) => roles.inProgress.has(t.statusId)).map(row).sort(oldestFirst).slice(0, 5);
    const waitingReview = s.issues.filter((t) => roles.review.has(t.statusId)).map(row).sort(oldestFirst).slice(0, 5);

    const proposed = await this.repo.proposedDecisionCount(p.id);
    const members = await this.repo.teamMemberCount(p.id);
    const sync = await this.syncHealth(actor, teamId);
    return {
      aging,
      waitingReview,
      quiet: sync.quiet.slice(0, 5),
      proposedDecisions: proposed,
      members: { count: members, myRole: await this.access.roleOn(actor, p.id) },
      issues: s.issues.length,
    };
  }
}
