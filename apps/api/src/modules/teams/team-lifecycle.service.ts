import { Inject, Injectable } from "@nestjs/common";
import type { TeamRole } from "../../db/schema";
import type { Actor } from "../../common/actor";
import { ServiceError } from "../../common/service-error";
import { Database } from "../../platform/database/database";
import { EventsService } from "../../platform/events/events.service";
import { TeamAccessService } from "./team-access.service";
import { TeamsRepository, type TeamRow } from "./teams.repository";

/**
 * A team's lifecycle (active → retired → deleted) and its place in a hierarchy (WH-128). The guards here are shared by the actions
 * (which run them inside the transaction, after locking the workspace's teams) and by the team settings read (which shows the same
 * reason beside a disabled button), so what the screen says is what the API would answer. A parent grants no access (ADR-23).
 */

export type Guard = { allowed: boolean; reason: string | null };
const guard = (reason: string | null): Guard => ({ allowed: !reason, reason });

export type TeamSettings = {
  team: { id: string; key: string; name: string; retired: boolean; retiredAt: Date | null };
  myRole: TeamRole;
  /** The parent, when the person can open it; a parent they cannot open is not named. */
  parent: { key: string; name: string; retired: boolean } | null;
  /** Child teams the person can open, and how many more they cannot. */
  children: { key: string; name: string; retired: boolean }[];
  hiddenChildren: number;
  canLeave: Guard;
  canRetire: Guard;
  canDelete: Guard;
};

function people(actor: Actor, what: string) {
  if (actor.kind !== "human" || actor.system) throw new ServiceError("forbidden", `Only people can ${what}`);
}

@Injectable()
export class TeamLifecycleService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(TeamsRepository) private readonly repo: TeamsRepository,
    @Inject(TeamAccessService) private readonly access: TeamAccessService,
    @Inject(EventsService) private readonly events: EventsService,
  ) {}

  /** Live projects the team leads, as a message; null when it leads none. */
  private async leadsProjectBlock(team: TeamRow) {
    const led = await this.repo.liveProjectNamesLedBy(team.id);
    if (!led.length) return null;
    return `${team.name} leads ${led.map((x) => `"${x.name}"`).join(", ")}. Make another team the lead of ${led.length === 1 ? "that project" : "those projects"} first.`;
  }

  /** Child teams in the way, as a message naming those the actor can open and counting those they cannot. A retired child does not block a retire, only a delete. */
  private async childrenBlock(actor: Actor, team: TeamRow, action: "retire" | "delete") {
    const kids = await this.repo.childTeams(team, action === "retire");
    if (!kids.length) return null;
    const seen = new Set(await this.access.visibleTeamIds(actor));
    const mine = kids.filter((k) => seen.has(k.id));
    const hidden = kids.length - mine.length;
    const names = mine.map((k) => `${k.name} (${k.key})`).join(", ");
    const list = mine.length ? (hidden ? `${names} and ${hidden} you cannot see` : names) : `${hidden} you cannot see`;
    return `${team.name} has child teams: ${list}. ${action === "retire" ? "Re-parent, retire or delete" : "Re-parent or delete"} them first.`;
  }

  /** Why the team cannot be retired right now, or null. Run inside the transaction that retires it. */
  async retireBlock(actor: Actor, team: TeamRow): Promise<string | null> {
    if (team.retiredAt) return `${team.name} is already retired.`;
    if (!(await this.repo.countOtherActiveTeams(team))) return "This is the last active team in the workspace, so it cannot be retired.";
    return (await this.leadsProjectBlock(team)) ?? (await this.childrenBlock(actor, team, "retire"));
  }

  /** Why the team cannot be deleted right now, or null. A retired team is not limited by the last-active-team rule. */
  async deleteBlock(actor: Actor, team: TeamRow): Promise<string | null> {
    if (!team.retiredAt && !(await this.repo.countOtherActiveTeams(team))) return "This is the last active team in the workspace, so it cannot be deleted.";
    return (await this.leadsProjectBlock(team)) ?? (await this.childrenBlock(actor, team, "delete"));
  }

  /** Retire a team: read only, hidden from the main sidebar, kept with its data and members. Team admins only. */
  async retire(actor: Actor, ref: string) {
    people(actor, "retire a team");
    const found = await this.access.require(actor, ref, "admin");
    return this.db.transaction(async () => {
      await this.access.lockWorkspaceTeams(found.workspaceId);
      const team = await this.repo.teamById(found.id);
      if (!team) throw new ServiceError("not_found", `Team ${ref} not found`);
      const why = await this.retireBlock(actor, team);
      if (why) throw new ServiceError("conflict", why);
      const row = await this.repo.updateTeam(team.id, { retiredAt: new Date(), retiredBy: actor.id });
      await this.access.audit(actor, { action: "team.retired", targetType: "team", targetId: team.id, teamId: team.id, after: { key: team.key } });
      await this.events.emit(actor, team.id, { type: "team.retired", entity: "team", entityId: team.id, summary: `retired team ${team.name}` });
      return row;
    });
  }

  /** Bring a retired team back, with everything intact. Team admins only (a workspace owner or admin joins as admin first). */
  async restore(actor: Actor, ref: string) {
    people(actor, "restore a team");
    const found = await this.access.require(actor, ref, "admin");
    return this.db.transaction(async () => {
      await this.access.lockWorkspaceTeams(found.workspaceId);
      const team = await this.repo.teamById(found.id);
      if (!team) throw new ServiceError("not_found", `Team ${ref} not found`);
      if (!team.retiredAt) throw new ServiceError("conflict", `${team.name} is not retired.`);
      const row = await this.repo.updateTeam(team.id, { retiredAt: null, retiredBy: null });
      await this.access.audit(actor, { action: "team.restored", targetType: "team", targetId: team.id, teamId: team.id, after: { key: team.key } });
      await this.events.emit(actor, team.id, { type: "team.restored", entity: "team", entityId: team.id, summary: `restored team ${team.name}` });
      return row;
    });
  }

  /**
   * Check a candidate parent for a team (`team` is null while one is being created): in the same workspace, one the actor can open, and
   * not the team itself or one of its descendants. A parent of another workspace or one the actor cannot open answers not_found.
   */
  async resolveParent(actor: Actor, team: TeamRow | null, parentRef: string): Promise<TeamRow> {
    const parent = await this.access.find(actor, parentRef);
    if (!parent || !(await this.access.roleOn(actor, parent.id))) throw new ServiceError("not_found", `Team ${parentRef} not found`);
    if (team) {
      if (parent.id === team.id) throw new ServiceError("invalid", "A team cannot be its own parent");
      // Walk up from the new parent: meeting the team means it would become its own ancestor.
      const seen = new Set<string>();
      for (let at: string | null = parent.id; at && !seen.has(at); ) {
        if (at === team.id) throw new ServiceError("invalid", `${parent.name} is inside ${team.name}, so it cannot be its parent`);
        seen.add(at);
        at = await this.repo.parentIdOf(at);
      }
    }
    return parent;
  }

  /** Set, change or clear (`null`) a team's parent. Admin of the team, who must also be able to open the new parent. */
  async setParent(actor: Actor, ref: string, parentRef: string | null) {
    people(actor, "change a team's parent");
    const found = await this.access.require(actor, ref, "admin");
    return this.db.transaction(async () => {
      await this.access.lockWorkspaceTeams(found.workspaceId);
      const team = (await this.repo.teamById(found.id))!;
      const parent = parentRef ? await this.resolveParent(actor, team, parentRef) : null;
      if ((parent?.id ?? null) === team.parentId) return team;
      const before = team.parentId ? await this.repo.idAndKey(team.parentId) : undefined;
      const row = await this.repo.updateTeam(team.id, { parentId: parent?.id ?? null });
      await this.access.audit(actor, {
        action: "team.parent_changed",
        targetType: "team",
        targetId: team.id,
        teamId: team.id,
        before: { parentId: before?.id ?? null, parentKey: before?.key ?? null },
        after: { parentId: parent?.id ?? null, parentKey: parent?.key ?? null },
      });
      await this.events.emit(actor, team.id, { type: "team.parent_changed", entity: "team", entityId: team.id, summary: parent ? `moved team ${team.name} under ${parent.name}` : `made team ${team.name} a top-level team` });
      return row;
    });
  }

  /** The team settings read: the team's place in the hierarchy and, for each Danger zone action, whether it is allowed and why not. */
  async settings(actor: Actor, ref: string): Promise<TeamSettings> {
    people(actor, "open team settings");
    const team = await this.access.require(actor, ref, "read");
    const role = (await this.access.roleOn(actor, team.id)) as TeamRole;
    const seen = new Set(await this.access.visibleTeamIds(actor));
    const kids = await this.repo.childRows(team);
    const parent = team.parentId && seen.has(team.parentId) ? await this.repo.teamById(team.parentId) : undefined;
    const view = (t: TeamRow) => ({ key: t.key, name: t.name, retired: !!t.retiredAt });
    const admin = role === "admin";
    return {
      team: { id: team.id, key: team.key, name: team.name, retired: !!team.retiredAt, retiredAt: team.retiredAt },
      myRole: role,
      parent: parent ? view(parent) : null,
      children: kids.filter((k) => seen.has(k.id)).map(view),
      hiddenChildren: kids.filter((k) => !seen.has(k.id)).length,
      canLeave: guard(await this.access.leaveBlock(team, actor.id)),
      canRetire: guard(admin ? await this.retireBlock(actor, team) : "Only a team admin can retire a team"),
      canDelete: guard(admin ? await this.deleteBlock(actor, team) : "Only a team admin can delete a team"),
    };
  }

  /** The teams the person can open that could be this team's parent: not itself and not one of its descendants. `ref` is omitted while a team is being created. */
  async parentCandidates(actor: Actor, ref?: string) {
    people(actor, "pick a parent team");
    const team = ref ? await this.access.require(actor, ref, "admin") : null;
    const ids = await this.access.visibleTeamIds(actor);
    if (!ids.length) return [];
    const rows = await this.repo.teamsAmong(actor.workspaceId, ids);
    const all = await this.repo.parentLinks(actor.workspaceId);
    const up = new Map(all.map((t) => [t.id, t.parentId]));
    const inside = (id: string) => {
      for (let at: string | null | undefined = id, n = 0; at && n < 1000; at = up.get(at), n++) if (at === team!.id) return true;
      return false;
    };
    return rows.filter((t) => !team || !inside(t.id)).map((t) => ({ id: t.id, key: t.key, name: t.name, retired: !!t.retiredAt }));
  }
}
