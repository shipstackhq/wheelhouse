import { and, asc, desc, eq, gt, isNull, lt, lte, ne, or, sql } from "drizzle-orm";
import { getDb, schema } from "../db";
import type { Actor } from "../common/actor";
import { bucketOf, REMOVED_KEEP_MS, SESSION_IDLE_LIMIT_MS } from "@wheelhouse/shared/session-buckets";
import { bus } from "../platform/events/event-bus";
import { ServiceError } from "../common/service-error";
import { Q } from "../platform/database/transaction";
import { listTeams, requireTeam } from "../modules/teams/index";

const { issues, nodes, events, agentCursors, workSessions, docs } = schema;

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
export async function cursorFor(q: Q, key: { id: string; createdAt: Date }, teamId: string) {
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

export async function keyRow(q: Q, keyId: string) {
  const [k] = await q.select().from(schema.apiKeys).where(eq(schema.apiKeys.id, keyId));
  if (!k) throw new ServiceError("not_found", "API key not found");
  return k;
}

/**
 * Changes the caller didn't make itself. A caller that names its session excludes
 * only that session's writes, so sessions sharing one API key see each other's
 * work; without a session, everything written with the key is excluded.
 */
export const notMine = (who: { id: string; sessionId?: string }) =>
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
export async function sessionCursor(q: Q, actor: Actor, teamId: string) {
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
