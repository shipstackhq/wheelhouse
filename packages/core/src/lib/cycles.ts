import { and, asc, eq, gt, gte, inArray, isNull, lt, lte, ne, sql } from "drizzle-orm";
import { getDb, schema } from "../db";
import type { Actor } from "./access";
import { emit, requireTeam, type Q, type Tx } from "./service";
import { ServiceError } from "./service-error";

/**
 * Cycles (WH-117): an optional window of one to fourteen days with a goal, belonging to a team (ADR-11, revised). An issue joins
 * when it is ready, not at the start; when the window ends, what is not done moves to the next cycle once. No points, no velocity.
 * Every function takes `now` so the whole thing can be tested against a fixed clock.
 */

const { cycles, issues, columns, events, teams } = schema;
export type CycleRow = typeof cycles.$inferSelect;
export type CycleState = "upcoming" | "current" | "past";

const DAY = 86_400_000;
export const CYCLE_MIN_MS = DAY;
export const CYCLE_MAX_MS = 14 * DAY;
const NIL_UUID = "00000000-0000-0000-0000-000000000000";

/** Cycles that roll over, and the first one the sweep creates, are Wheelhouse's own doing, like the claim sweep's. */
const systemActor = (workspaceId: string, teamId: string): Actor => ({ kind: "human", id: NIL_UUID, name: "Wheelhouse", workspaceId, system: true, teamId });

export const stateOf = (c: Pick<CycleRow, "startsAt" | "endsAt">, now: Date): CycleState =>
  c.endsAt.getTime() <= now.getTime() ? "past" : c.startsAt.getTime() <= now.getTime() ? "current" : "upcoming";

export const cycleLabel = (c: Pick<CycleRow, "number" | "name">) => (c.name ? `Cycle ${c.number}: ${c.name}` : `Cycle ${c.number}`);

const bad = (field: string, message: string): never => {
  throw new ServiceError("invalid", message, { fields: { [field]: message } });
};

function toDate(v: unknown, field: string): Date {
  const d = v instanceof Date ? v : typeof v === "string" || typeof v === "number" ? new Date(v) : null;
  if (!d || Number.isNaN(d.getTime())) return bad(field, `${field} must be a date and time`);
  return d;
}

function checkWindow(startsAt: Date, endsAt: Date) {
  if (endsAt.getTime() <= startsAt.getTime()) bad("endsAt", "A cycle must end after it starts");
  const len = endsAt.getTime() - startsAt.getTime();
  if (len < CYCLE_MIN_MS) bad("endsAt", "A cycle lasts at least one day");
  if (len > CYCLE_MAX_MS) bad("endsAt", "A cycle lasts at most two weeks");
}

/** Lock the team's row for the rest of the transaction, so two people cannot both create overlapping cycles. */
async function lockTeam(tx: Tx, teamId: string) {
  await tx.select({ id: teams.id }).from(teams).where(eq(teams.id, teamId)).for("update");
}

async function assertNoOverlap(q: Q, teamId: string, startsAt: Date, endsAt: Date, exceptId?: string) {
  const [hit] = await q
    .select()
    .from(cycles)
    .where(and(eq(cycles.teamId, teamId), lt(cycles.startsAt, endsAt), gt(cycles.endsAt, startsAt), exceptId ? ne(cycles.id, exceptId) : undefined))
    .limit(1);
  if (hit) throw new ServiceError("conflict", `That overlaps ${cycleLabel(hit)} (${hit.startsAt.toISOString().slice(0, 10)} to ${hit.endsAt.toISOString().slice(0, 10)}). Cycles of a team do not overlap.`);
}

async function resolveCycle(q: Q, teamId: string, number: number): Promise<CycleRow> {
  const [c] = Number.isSafeInteger(number) ? await q.select().from(cycles).where(and(eq(cycles.teamId, teamId), eq(cycles.number, number))) : [];
  if (!c) throw new ServiceError("not_found", `Cycle ${number} not found`);
  return c;
}

/** The cycle of this team with that number, for an issue to join. A cycle that has ended is closed to new issues. */
export async function cycleForIssue(q: Q, teamId: string, number: number, now = new Date()): Promise<CycleRow> {
  const c = await resolveCycle(q, teamId, number).catch((e) => {
    if (e instanceof ServiceError && e.code === "not_found") return bad("cycle", `This team has no cycle ${number}`);
    throw e;
  });
  if (stateOf(c, now) === "past") bad("cycle", `${cycleLabel(c)} has ended; join the current or an upcoming cycle`);
  return c;
}

// ───────── counts ─────────

export type CycleSummary = {
  number: number;
  name: string;
  goal: string;
  startsAt: Date;
  endsAt: Date;
  state: CycleState;
  /** Issues in the cycle now, how many of them are done, how many are still open (a custom column counts as open). */
  total: number;
  done: number;
  open: number;
};

async function summaries(q: Q, rows: CycleRow[], now: Date): Promise<CycleSummary[]> {
  if (!rows.length) return [];
  const counts = await q
    .select({
      cycleId: issues.cycleId,
      total: sql<number>`count(*)::int`,
      done: sql<number>`count(*) filter (where ${columns.role} = 'done')::int`,
    })
    .from(issues)
    .innerJoin(columns, eq(columns.id, issues.columnId))
    .where(inArray(issues.cycleId, rows.map((r) => r.id)))
    .groupBy(issues.cycleId);
  const by = new Map(counts.map((c) => [c.cycleId, c]));
  return rows.map((c) => {
    const n = by.get(c.id);
    const total = Number(n?.total ?? 0);
    const done = Number(n?.done ?? 0);
    return { number: c.number, name: c.name, goal: c.goal, startsAt: c.startsAt, endsAt: c.endsAt, state: stateOf(c, now), total, done, open: total - done };
  });
}

// ───────── rollover ─────────

export type RolloverResult = { cycles: number; moved: number };

/**
 * Cycles whose window has ended hand their unfinished issues (any column but a done one) to the next cycle of the team, once:
 * `rolled_over_at` is set whether or not anything moved, so running it again, or from two requests at once, changes nothing. The
 * next cycle is the team's next one by start; if there is none, one of the same length is made, starting where this one ended and
 * moved on by whole lengths if the team was away, so it holds `now`. Reads call this, as the claim sweep does.
 */
export async function rolloverCycles(teamId: string, now = new Date()): Promise<RolloverResult> {
  const db = await getDb();
  const [pending] = await db.select({ id: cycles.id }).from(cycles).where(and(eq(cycles.teamId, teamId), lte(cycles.endsAt, now), isNull(cycles.rolledOverAt))).limit(1);
  if (!pending) return { cycles: 0, moved: 0 };
  return db.transaction(async (tx) => {
    await lockTeam(tx, teamId);
    const result: RolloverResult = { cycles: 0, moved: 0 };
    // Re-read under the lock: another request may have done it while this one waited.
    const ended = await tx.select().from(cycles).where(and(eq(cycles.teamId, teamId), lte(cycles.endsAt, now), isNull(cycles.rolledOverAt))).orderBy(asc(cycles.startsAt));
    for (const c of ended) {
      const unfinished = await tx
        .select({ id: issues.id, number: issues.number, version: issues.version })
        .from(issues)
        .innerJoin(columns, eq(columns.id, issues.columnId))
        .where(and(eq(issues.cycleId, c.id), sql`${columns.role} is distinct from 'done'`));
      if (unfinished.length) {
        let [next] = await tx.select().from(cycles).where(and(eq(cycles.teamId, teamId), gte(cycles.startsAt, c.endsAt))).orderBy(asc(cycles.startsAt)).limit(1);
        if (!next) {
          const len = c.endsAt.getTime() - c.startsAt.getTime();
          const skip = Math.max(0, Math.floor((now.getTime() - c.endsAt.getTime()) / len));
          const startsAt = new Date(c.endsAt.getTime() + skip * len);
          const [{ max }] = await tx.select({ max: sql<number>`coalesce(max(${cycles.number}), 0)::int` }).from(cycles).where(eq(cycles.teamId, teamId));
          [next] = await tx.insert(cycles).values({ teamId, workspaceId: c.workspaceId, number: Number(max) + 1, startsAt, endsAt: new Date(startsAt.getTime() + len) }).returning();
          await emit(tx, systemActor(c.workspaceId, teamId), teamId, { type: "cycle.created", entity: "cycle", entityId: next.id, summary: `started ${cycleLabel(next)} after ${cycleLabel(c)} ended`, data: { number: next.number, after: c.number } });
        }
        await tx.update(issues).set({ cycleId: next.id, version: sql`${issues.version} + 1`, updatedAt: now }).where(inArray(issues.id, unfinished.map((t) => t.id)));
        const [team] = await tx.select({ key: teams.key }).from(teams).where(eq(teams.id, teamId));
        await emit(tx, systemActor(c.workspaceId, teamId), teamId, {
          type: "cycle.rolled_over",
          entity: "cycle",
          entityId: c.id,
          summary: `${unfinished.length} unfinished issue${unfinished.length === 1 ? "" : "s"} moved from ${cycleLabel(c)} to ${cycleLabel(next)}`,
          data: { from: c.number, to: next.number, moved: unfinished.length, refs: unfinished.map((t) => `${team.key}-${t.number}`) },
        });
        result.moved += unfinished.length;
      }
      await tx.update(cycles).set({ rolledOverAt: now }).where(eq(cycles.id, c.id));
      result.cycles++;
    }
    return result;
  });
}

// ───────── the cycles of a team ─────────

export type CycleList = { current: CycleSummary | null; upcoming: CycleSummary[]; past: CycleSummary[] };

export async function listCycles(actor: Actor, teamRef: string, now = new Date()): Promise<CycleList> {
  const team = await requireTeam(actor, teamRef);
  await rolloverCycles(team.id, now);
  const db = await getDb();
  const all = await summaries(db, await db.select().from(cycles).where(eq(cycles.teamId, team.id)).orderBy(asc(cycles.startsAt)), now);
  return {
    current: all.find((c) => c.state === "current") ?? null,
    upcoming: all.filter((c) => c.state === "upcoming"),
    past: all.filter((c) => c.state === "past").reverse(),
  };
}

export type CycleInput = { name?: string; goal?: string; startsAt?: unknown; endsAt?: unknown };

const clean = (s: unknown, field: string, max: number) => {
  if (s === undefined) return undefined;
  if (typeof s !== "string") return bad(field, `${field} must be text`);
  const t = s.trim();
  if (t.length > max) return bad(field, `${field} is at most ${max} characters`);
  return t;
};

/** Start a cycle. Without dates it runs from now for two weeks; without an end it lasts two weeks. */
export async function createCycle(actor: Actor, teamRef: string, input: CycleInput, now = new Date()): Promise<CycleSummary> {
  const team = await requireTeam(actor, teamRef, "edit");
  const startsAt = input.startsAt === undefined ? now : toDate(input.startsAt, "startsAt");
  const endsAt = input.endsAt === undefined ? new Date(startsAt.getTime() + CYCLE_MAX_MS) : toDate(input.endsAt, "endsAt");
  checkWindow(startsAt, endsAt);
  const name = clean(input.name, "name", 60) ?? "";
  const goal = clean(input.goal, "goal", 500) ?? "";
  const db = await getDb();
  const row = await db.transaction(async (tx) => {
    await lockTeam(tx, team.id);
    await assertNoOverlap(tx, team.id, startsAt, endsAt);
    const [{ max }] = await tx.select({ max: sql<number>`coalesce(max(${cycles.number}), 0)::int` }).from(cycles).where(eq(cycles.teamId, team.id));
    const [c] = await tx.insert(cycles).values({ teamId: team.id, workspaceId: team.workspaceId, number: Number(max) + 1, name, goal, startsAt, endsAt }).returning();
    await emit(tx, actor, team.id, { type: "cycle.created", entity: "cycle", entityId: c.id, summary: `planned ${cycleLabel(c)}`, data: { number: c.number, startsAt: c.startsAt, endsAt: c.endsAt, goal: c.goal } });
    return c;
  });
  return (await summaries(db, [row], now))[0];
}

/** Rename, set the goal, or move the window. A cycle that has ended keeps its dates (the report reads them). */
export async function updateCycle(actor: Actor, teamRef: string, number: number, patch: CycleInput, now = new Date()): Promise<CycleSummary> {
  const team = await requireTeam(actor, teamRef, "edit");
  const db = await getDb();
  const row = await db.transaction(async (tx) => {
    await lockTeam(tx, team.id);
    const c = await resolveCycle(tx, team.id, number);
    const set: Partial<typeof cycles.$inferInsert> = {};
    const name = clean(patch.name, "name", 60);
    const goal = clean(patch.goal, "goal", 500);
    if (name !== undefined && name !== c.name) set.name = name;
    if (goal !== undefined && goal !== c.goal) set.goal = goal;
    if (patch.startsAt !== undefined || patch.endsAt !== undefined) {
      if (stateOf(c, now) === "past") bad("startsAt", `${cycleLabel(c)} has ended; its dates stay as they were`);
      const startsAt = patch.startsAt === undefined ? c.startsAt : toDate(patch.startsAt, "startsAt");
      const endsAt = patch.endsAt === undefined ? c.endsAt : toDate(patch.endsAt, "endsAt");
      checkWindow(startsAt, endsAt);
      if (startsAt.getTime() !== c.startsAt.getTime() || endsAt.getTime() !== c.endsAt.getTime()) {
        await assertNoOverlap(tx, team.id, startsAt, endsAt, c.id);
        set.startsAt = startsAt;
        set.endsAt = endsAt;
      }
    }
    if (!Object.keys(set).length) return c;
    const [u] = await tx.update(cycles).set(set).where(eq(cycles.id, c.id)).returning();
    await emit(tx, actor, team.id, { type: "cycle.updated", entity: "cycle", entityId: u.id, summary: `updated ${cycleLabel(u)}: ${Object.keys(set).join(", ")}`, data: { number: u.number, changed: Object.keys(set) } });
    return u;
  });
  return (await summaries(db, [row], now))[0];
}

/** Delete a cycle. Its issues stay on the board, in no cycle. */
export async function deleteCycle(actor: Actor, teamRef: string, number: number) {
  const team = await requireTeam(actor, teamRef, "edit");
  const db = await getDb();
  return db.transaction(async (tx) => {
    const c = await resolveCycle(tx, team.id, number);
    const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(issues).where(eq(issues.cycleId, c.id));
    await tx.delete(cycles).where(eq(cycles.id, c.id));
    await emit(tx, actor, team.id, { type: "cycle.deleted", entity: "cycle", entityId: c.id, summary: `deleted ${cycleLabel(c)}${Number(n) ? ` (${n} issue${Number(n) === 1 ? "" : "s"} left it)` : ""}`, data: { number: c.number } });
    return { ok: true, number: c.number, released: Number(n) };
  });
}

// ───────── what landed ─────────

export type Landed = { ref: string; title: string; issueId: string; doneAt: Date; inCycle: boolean };

/**
 * Issues that reached a done column inside [from, to), from the event log (an older event only recorded the column's name, so
 * that is matched against the team's done columns). An issue counts once, at its first move to done in the window, and an issue
 * since deleted is not listed. `inCycle` says whether it is in that cycle now.
 */
export async function landedBetween(q: Q, teamId: string, from: Date, to: Date, cycleId?: string): Promise<Landed[]> {
  const doneNames = new Set((await q.select({ name: columns.name }).from(columns).where(and(eq(columns.teamId, teamId), eq(columns.role, "done")))).map((c) => c.name));
  const moves = await q
    .select()
    .from(events)
    .where(and(eq(events.teamId, teamId), eq(events.type, "issue.moved"), gte(events.createdAt, from), lt(events.createdAt, to)))
    .orderBy(asc(events.seq));
  const first = new Map<string, (typeof moves)[number]>();
  for (const e of moves) {
    const d = (e.data ?? {}) as { toRole?: string | null; to?: string };
    const toDone = d.toRole ? d.toRole === "done" : doneNames.has(String(d.to));
    if (toDone && !first.has(e.entityId)) first.set(e.entityId, e);
  }
  if (!first.size) return [];
  const rows = await q.select({ id: issues.id, title: issues.title, cycleId: issues.cycleId, number: issues.number }).from(issues).where(inArray(issues.id, [...first.keys()]));
  const [team] = await q.select({ key: teams.key }).from(teams).where(eq(teams.id, teamId));
  return rows
    .map((t) => ({ ref: `${team.key}-${t.number}`, title: t.title, issueId: t.id, doneAt: first.get(t.id)!.createdAt, inCycle: !!cycleId && t.cycleId === cycleId }))
    .sort((a, b) => a.doneAt.getTime() - b.doneAt.getTime() || a.ref.localeCompare(b.ref, undefined, { numeric: true }));
}

export type CycleDetail = CycleSummary & {
  issues: { ref: string; title: string; priority: string; column: string; done: boolean; assigneeId: string | null }[];
  /** Issues that reached done while the cycle ran (the window, not only the issues in it), and which of them are in it. */
  landed: Landed[];
};

export async function getCycle(actor: Actor, teamRef: string, number: number, now = new Date()): Promise<CycleDetail> {
  const team = await requireTeam(actor, teamRef);
  await rolloverCycles(team.id, now);
  const db = await getDb();
  const c = await resolveCycle(db, team.id, number);
  const [summary] = await summaries(db, [c], now);
  const inCycle = await db
    .select({ number: issues.number, title: issues.title, priority: issues.priority, column: columns.name, role: columns.role, assigneeId: issues.assigneeId })
    .from(issues)
    .innerJoin(columns, eq(columns.id, issues.columnId))
    .where(eq(issues.cycleId, c.id))
    .orderBy(asc(issues.number));
  // A cycle that has not started has landed nothing; one that is running reports up to now.
  const landed = c.startsAt.getTime() > now.getTime() ? [] : await landedBetween(db, team.id, c.startsAt, new Date(Math.min(c.endsAt.getTime(), now.getTime() + 1)), c.id);
  return {
    ...summary,
    issues: inCycle.map((t) => ({ ref: `${team.key}-${t.number}`, title: t.title, priority: t.priority, column: t.column, done: t.role === "done", assigneeId: t.assigneeId })),
    landed,
  };
}

export type CycleOption = { number: number; name: string; startsAt: Date; endsAt: Date; state: CycleState };

/** What the board needs of a team's cycles: to name a chip and fill a filter. The newest thirty, current and upcoming first. */
export async function cycleOptions(q: Q, teamId: string, now = new Date()): Promise<CycleOption[]> {
  const rows = await q.select().from(cycles).where(eq(cycles.teamId, teamId)).orderBy(sql`${cycles.startsAt} desc`).limit(30);
  return rows.map((c) => ({ number: c.number, name: c.name, startsAt: c.startsAt, endsAt: c.endsAt, state: stateOf(c, now) }));
}

/** The cycle numbers of a set of issues' cycle ids, for views that show a chip. */
export async function cycleNumbers(q: Q, cycleIds: (string | null)[]): Promise<Map<string, number>> {
  const ids = [...new Set(cycleIds.filter((x): x is string => !!x))];
  if (!ids.length) return new Map();
  return new Map((await q.select({ id: cycles.id, number: cycles.number }).from(cycles).where(inArray(cycles.id, ids))).map((c) => [c.id, c.number]));
}
