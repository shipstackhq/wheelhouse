import { Inject, Injectable } from "@nestjs/common";
import type { Actor } from "../../../common/actor";
import { ServiceError } from "../../../common/service-error";
import { Database } from "../../../platform/database/database";
import { EventsService } from "../../../platform/events/events.service";
import { TeamAccessService } from "../../teams/index";
import { CyclesRepository, type CycleRow } from "./cycles.repository";
import { CYCLE_MAX_MS, bad, checkWindow, cleanText, cycleLabel, nextWindow, stateOf, toDate, type CycleInput, type CycleState } from "../issues.rules";

/**
 * Cycles (WH-117): an optional window of one to fourteen days with a goal, belonging to a team (ADR-11, revised). An issue joins
 * when it is ready, not at the start; when the window ends, what is not done moves to the next cycle once. No points, no velocity.
 * Every method takes `now` so the whole thing can be tested against a fixed clock.
 */

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

/** Cycles that roll over, and the first one the sweep creates, are Wheelhouse's own doing, like the claim sweep's. */
export const systemActor = (workspaceId: string, teamId: string): Actor => ({ kind: "human", id: NIL_UUID, name: "Wheelhouse", workspaceId, system: true, teamId });

export type { CycleRow };

export type CycleSummary = {
  number: number;
  name: string;
  goal: string;
  startsAt: Date;
  endsAt: Date;
  state: CycleState;
  /** Issues in the cycle now, how many of them are done, how many are still open (a custom status counts as open; a canceled issue is not counted at all). */
  total: number;
  done: number;
  open: number;
};

export type RolloverResult = { cycles: number; moved: number };
export type CycleList = { current: CycleSummary | null; upcoming: CycleSummary[]; past: CycleSummary[] };
export type Landed = { ref: string; title: string; issueId: string; doneAt: Date; inCycle: boolean };
export type CycleDetail = CycleSummary & {
  issues: { ref: string; title: string; priority: string; status: string; done: boolean; assigneeId: string | null }[];
  /** Issues that reached done while the cycle ran (the window, not only the issues in it), and which of them are in it. */
  landed: Landed[];
};
export type CycleOption = { number: number; name: string; startsAt: Date; endsAt: Date; state: CycleState };

@Injectable()
export class CyclesService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(CyclesRepository) private readonly repo: CyclesRepository,
    @Inject(TeamAccessService) private readonly access: TeamAccessService,
    @Inject(EventsService) private readonly events: EventsService,
  ) {}

  private async assertNoOverlap(teamId: string, startsAt: Date, endsAt: Date, exceptId?: string) {
    const hit = await this.repo.overlapping(teamId, startsAt, endsAt, exceptId);
    if (hit) throw new ServiceError("conflict", `That overlaps ${cycleLabel(hit)} (${hit.startsAt.toISOString().slice(0, 10)} to ${hit.endsAt.toISOString().slice(0, 10)}). Cycles of a team do not overlap.`);
  }

  private async resolveCycle(teamId: string, number: number): Promise<CycleRow> {
    const c = await this.repo.findByNumber(teamId, number);
    if (!c) throw new ServiceError("not_found", `Cycle ${number} not found`);
    return c;
  }

  /** The cycle of this team with that number, for an issue to join. A cycle that has ended is closed to new issues. */
  async cycleForIssue(teamId: string, number: number, now = new Date()): Promise<CycleRow> {
    const c = await this.resolveCycle(teamId, number).catch((e) => {
      if (e instanceof ServiceError && e.code === "not_found") return bad("cycle", `This team has no cycle ${number}`);
      throw e;
    });
    if (stateOf(c, now) === "past") bad("cycle", `${cycleLabel(c)} has ended; join the current or an upcoming cycle`);
    return c;
  }

  /** Rows of issues with the `cycle` number they are in (null when in none). */
  async withCycle<T extends { cycleId: string | null }>(rows: T[]): Promise<(T & { cycle: number | null })[]> {
    const numbers = await this.cycleNumbers(rows.map((r) => r.cycleId));
    return rows.map((r) => ({ ...r, cycle: r.cycleId ? (numbers.get(r.cycleId) ?? null) : null }));
  }

  /** The cycle numbers of a set of issues' cycle ids, for views that show a chip. */
  async cycleNumbers(cycleIds: (string | null)[]): Promise<Map<string, number>> {
    const ids = [...new Set(cycleIds.filter((x): x is string => !!x))];
    if (!ids.length) return new Map();
    return new Map((await this.repo.numbersOf(ids)).map((c) => [c.id, c.number]));
  }

  // ───────── counts ─────────

  private async summaries(rows: CycleRow[], now: Date): Promise<CycleSummary[]> {
    if (!rows.length) return [];
    const by = new Map((await this.repo.counts(rows.map((r) => r.id))).map((c) => [c.cycleId, c]));
    return rows.map((c) => {
      const n = by.get(c.id);
      const total = Number(n?.total ?? 0);
      const done = Number(n?.done ?? 0);
      return { number: c.number, name: c.name, goal: c.goal, startsAt: c.startsAt, endsAt: c.endsAt, state: stateOf(c, now), total, done, open: total - done };
    });
  }

  // ───────── rollover ─────────

  /**
   * Cycles whose window has ended hand their unfinished issues (any status but a done or canceled one) to the next cycle of the team, once:
   * `rolled_over_at` is set whether or not anything moved, so running it again, or from two requests at once, changes nothing. The
   * next cycle is the team's next one by start; if there is none, one of the same length is made, starting where this one ended and
   * moved on by whole lengths if the team was away, so it holds `now`. Reads call this, as the claim sweep does.
   */
  async rolloverCycles(teamId: string, now = new Date()): Promise<RolloverResult> {
    if (!(await this.repo.pendingRollover(teamId, now))) return { cycles: 0, moved: 0 };
    return this.db.transaction(async () => {
      await this.repo.lockTeam(teamId);
      const result: RolloverResult = { cycles: 0, moved: 0 };
      // Re-read under the lock: another request may have done it while this one waited.
      for (const c of await this.repo.endedNotRolledOver(teamId, now)) {
        const unfinished = await this.repo.unfinishedIssues(c.id);
        if (unfinished.length) {
          let next = await this.repo.firstStartingFrom(teamId, c.endsAt);
          if (!next) {
            const window = nextWindow(c, now);
            const number = (await this.repo.maxNumber(teamId)) + 1;
            next = await this.repo.insertCycle({ teamId, workspaceId: c.workspaceId, number, ...window });
            await this.events.emit(systemActor(c.workspaceId, teamId), teamId, { type: "cycle.created", entity: "cycle", entityId: next.id, summary: `started ${cycleLabel(next)} after ${cycleLabel(c)} ended`, data: { number: next.number, after: c.number } });
          }
          await this.repo.moveIssuesToCycle(unfinished.map((t) => t.id), next.id, now);
          const key = await this.repo.teamKey(teamId);
          await this.events.emit(systemActor(c.workspaceId, teamId), teamId, {
            type: "cycle.rolled_over",
            entity: "cycle",
            entityId: c.id,
            summary: `${unfinished.length} unfinished issue${unfinished.length === 1 ? "" : "s"} moved from ${cycleLabel(c)} to ${cycleLabel(next)}`,
            data: { from: c.number, to: next.number, moved: unfinished.length, refs: unfinished.map((t) => `${key}-${t.number}`) },
          });
          result.moved += unfinished.length;
        }
        await this.repo.markRolledOver(c.id, now);
        result.cycles++;
      }
      return result;
    });
  }

  // ───────── the cycles of a team ─────────

  async listCycles(actor: Actor, teamRef: string, now = new Date()): Promise<CycleList> {
    const team = await this.access.require(actor, teamRef);
    await this.rolloverCycles(team.id, now);
    const all = await this.summaries(await this.repo.listOf(team.id), now);
    return {
      current: all.find((c) => c.state === "current") ?? null,
      upcoming: all.filter((c) => c.state === "upcoming"),
      past: all.filter((c) => c.state === "past").reverse(),
    };
  }

  /** Start a cycle. Without dates it runs from now for two weeks; without an end it lasts two weeks. */
  async createCycle(actor: Actor, teamRef: string, input: CycleInput, now = new Date()): Promise<CycleSummary> {
    const team = await this.access.require(actor, teamRef, "edit");
    const startsAt = input.startsAt === undefined ? now : toDate(input.startsAt, "startsAt");
    const endsAt = input.endsAt === undefined ? new Date(startsAt.getTime() + CYCLE_MAX_MS) : toDate(input.endsAt, "endsAt");
    checkWindow(startsAt, endsAt);
    const name = cleanText(input.name, "name", 60) ?? "";
    const goal = cleanText(input.goal, "goal", 500) ?? "";
    const row = await this.db.transaction(async () => {
      await this.repo.lockTeam(team.id);
      await this.assertNoOverlap(team.id, startsAt, endsAt);
      const c = await this.repo.insertCycle({ teamId: team.id, workspaceId: team.workspaceId, number: (await this.repo.maxNumber(team.id)) + 1, name, goal, startsAt, endsAt });
      await this.events.emit(actor, team.id, { type: "cycle.created", entity: "cycle", entityId: c.id, summary: `planned ${cycleLabel(c)}`, data: { number: c.number, startsAt: c.startsAt, endsAt: c.endsAt, goal: c.goal } });
      return c;
    });
    return (await this.summaries([row], now))[0];
  }

  /** Rename, set the goal, or move the window. A cycle that has ended keeps its dates (the report reads them). */
  async updateCycle(actor: Actor, teamRef: string, number: number, patch: CycleInput, now = new Date()): Promise<CycleSummary> {
    const team = await this.access.require(actor, teamRef, "edit");
    const row = await this.db.transaction(async () => {
      await this.repo.lockTeam(team.id);
      const c = await this.resolveCycle(team.id, number);
      const set: Partial<CycleRow> = {};
      const name = cleanText(patch.name, "name", 60);
      const goal = cleanText(patch.goal, "goal", 500);
      if (name !== undefined && name !== c.name) set.name = name;
      if (goal !== undefined && goal !== c.goal) set.goal = goal;
      if (patch.startsAt !== undefined || patch.endsAt !== undefined) {
        if (stateOf(c, now) === "past") bad("startsAt", `${cycleLabel(c)} has ended; its dates stay as they were`);
        const startsAt = patch.startsAt === undefined ? c.startsAt : toDate(patch.startsAt, "startsAt");
        const endsAt = patch.endsAt === undefined ? c.endsAt : toDate(patch.endsAt, "endsAt");
        checkWindow(startsAt, endsAt);
        if (startsAt.getTime() !== c.startsAt.getTime() || endsAt.getTime() !== c.endsAt.getTime()) {
          await this.assertNoOverlap(team.id, startsAt, endsAt, c.id);
          set.startsAt = startsAt;
          set.endsAt = endsAt;
        }
      }
      if (!Object.keys(set).length) return c;
      const u = await this.repo.updateCycle(c.id, set);
      await this.events.emit(actor, team.id, { type: "cycle.updated", entity: "cycle", entityId: u.id, summary: `updated ${cycleLabel(u)}: ${Object.keys(set).join(", ")}`, data: { number: u.number, changed: Object.keys(set) } });
      return u;
    });
    return (await this.summaries([row], now))[0];
  }

  /** Delete a cycle. Its issues stay on the board, in no cycle. */
  async deleteCycle(actor: Actor, teamRef: string, number: number) {
    const team = await this.access.require(actor, teamRef, "edit");
    return this.db.transaction(async () => {
      const c = await this.resolveCycle(team.id, number);
      const n = await this.repo.issueCount(c.id);
      await this.repo.deleteCycle(c.id);
      await this.events.emit(actor, team.id, { type: "cycle.deleted", entity: "cycle", entityId: c.id, summary: `deleted ${cycleLabel(c)}${n ? ` (${n} issue${n === 1 ? "" : "s"} left it)` : ""}`, data: { number: c.number } });
      return { ok: true, number: c.number, released: n };
    });
  }

  // ───────── what landed ─────────

  /**
   * Issues that reached a done status inside [from, to), from the event log (an older event only recorded the status's name, so
   * that is matched against the team's done statuses). An issue counts once, at its first move to done in the window, and an issue
   * since deleted is not listed. `inCycle` says whether it is in that cycle now.
   */
  async landedBetween(teamId: string, from: Date, to: Date, cycleId?: string): Promise<Landed[]> {
    const doneNames = await this.repo.doneStatusNames(teamId);
    const moves = await this.repo.moveEvents(teamId, from, to);
    const first = new Map<string, (typeof moves)[number]>();
    for (const e of moves) {
      const d = (e.data ?? {}) as { toRole?: string | null; to?: string };
      const toDone = d.toRole ? d.toRole === "done" : doneNames.has(String(d.to));
      if (toDone && !first.has(e.entityId)) first.set(e.entityId, e);
    }
    if (!first.size) return [];
    const rows = await this.repo.issuesByIds([...first.keys()]);
    const key = await this.repo.teamKey(teamId);
    return rows
      .map((t) => ({ ref: `${key}-${t.number}`, title: t.title, issueId: t.id, doneAt: first.get(t.id)!.createdAt, inCycle: !!cycleId && t.cycleId === cycleId }))
      .sort((a, b) => a.doneAt.getTime() - b.doneAt.getTime() || a.ref.localeCompare(b.ref, undefined, { numeric: true }));
  }

  async getCycle(actor: Actor, teamRef: string, number: number, now = new Date()): Promise<CycleDetail> {
    const team = await this.access.require(actor, teamRef);
    await this.rolloverCycles(team.id, now);
    const c = await this.resolveCycle(team.id, number);
    const [summary] = await this.summaries([c], now);
    const inCycle = await this.repo.issuesInCycle(c.id);
    // A cycle that has not started has landed nothing; one that is running reports up to now.
    const landed = c.startsAt.getTime() > now.getTime() ? [] : await this.landedBetween(team.id, c.startsAt, new Date(Math.min(c.endsAt.getTime(), now.getTime() + 1)), c.id);
    return {
      ...summary,
      issues: inCycle.map((t) => ({ ref: `${team.key}-${t.number}`, title: t.title, priority: t.priority, status: t.status, done: t.role === "done", assigneeId: t.assigneeId })),
      landed,
    };
  }

  /** What the board needs of a team's cycles: to name a chip and fill a filter. The newest thirty, current and upcoming first. */
  async cycleOptions(teamId: string, now = new Date()): Promise<CycleOption[]> {
    const rows = await this.repo.newest(teamId, 30);
    return rows.map((c) => ({ number: c.number, name: c.name, startsAt: c.startsAt, endsAt: c.endsAt, state: stateOf(c, now) }));
  }
}
