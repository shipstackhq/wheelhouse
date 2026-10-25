import { Inject, Injectable } from "@nestjs/common";
import type { TeamRole, WorkspaceRole } from "../../db/schema";
import type { Actor } from "../../common/actor";
import { assertWritable, effectiveRole, type Need, roleAllows } from "../../common/roles";
import { ServiceError } from "../../common/service-error";
import { isUuid } from "../../common/uuid";
import { TeamsRepository, type AuditInsert, type TeamRow } from "./teams.repository";

type AuditEntry = { action: string; targetType: "user" | "team" | "membership"; targetId?: string | null; teamId?: string | null; before?: Record<string, unknown> | null; after?: Record<string, unknown> | null };

/**
 * Who can open a team (ADR-23). A team is reachable only through a row in `team_members`; the workspace role never opens one by itself,
 * not even an owner's. This is the rule and the audit trail; `require` is the check every read and write path goes through.
 *
 * Agent keys and system actors (a GitHub webhook) are not people and have no row there. A key reaches the teams it is scoped to in
 * `api_key_teams` (as an editor, never an admin) and a system actor the one team it was made for; any other team answers exactly as it does
 * for a stranger (WH-120). The service other modules inject.
 */
@Injectable()
export class TeamAccessService {
  constructor(@Inject(TeamsRepository) private readonly repo: TeamsRepository) {}

  /** Finds a team of the actor's workspace by uuid or key, WITHOUT checking that the actor may open it. Only access code uses this. */
  find(actor: Actor, ref: string): Promise<TeamRow | undefined> {
    return this.repo.findTeam(actor.workspaceId, isUuid(ref) ? { id: ref } : { key: ref });
  }

  /**
   * Accepts a team uuid or its key (e.g. "WH"). A team of another workspace and a team the actor is not a member of both
   * answer not_found, so its existence does not leak; a member whose role is too low for `need` gets forbidden (ADR-23).
   */
  async require(actor: Actor, ref: string, need: Need = "read"): Promise<TeamRow> {
    const p = await this.find(actor, ref);
    const role = p ? await this.roleOn(actor, p.id) : null;
    if (!p || !role) throw new ServiceError("not_found", `Team ${ref} not found`);
    if (!roleAllows(role, need)) throw new ServiceError("forbidden", need === "admin" ? "Only a team admin can do that" : "Your role on this team is read only");
    // The one check behind every write path: a retired team can be read, never changed (WH-128).
    if (need === "edit") assertWritable(p);
    return p;
  }

  /** The actor's role on one team, or null when they cannot open it. The membership join also drops anyone removed from the workspace. */
  async roleOn(actor: Actor, teamId: string): Promise<TeamRole | null> {
    if (actor.kind === "agent" || actor.system) {
      if (actor.system) return actor.teamId === teamId ? "editor" : null;
      return (await this.repo.keyIsScopedTo(actor.id, teamId, actor.workspaceId)) ? "editor" : null;
    }
    const row = await this.repo.roleRow(teamId, actor.id, actor.workspaceId);
    return row ? effectiveRole(row.role, row.workspaceRole) : null;
  }

  /** Ids of the workspace's teams the actor can open. Used by every cross-team query. */
  async visibleTeamIds(actor: Actor): Promise<string[]> {
    if (actor.kind === "agent" || actor.system) return this.scopedTeamIds(actor);
    const rows = await this.repo.roleRows(actor.id, actor.workspaceId);
    return rows.map((r) => r.id);
  }

  /** The actor's role in each team they can open, by team id (editor in each team of a key or system actor). */
  async roleMap(actor: Actor): Promise<Map<string, TeamRole>> {
    if (actor.kind === "agent" || actor.system) return new Map((await this.scopedTeamIds(actor)).map((id) => [id, "editor" as const]));
    const rows = await this.repo.roleRows(actor.id, actor.workspaceId);
    return new Map(rows.flatMap((r) => { const e = effectiveRole(r.role, r.workspaceRole); return e ? [[r.id, e] as const] : []; }));
  }

  /** The person's role in the workspace, or null if they are not in it. */
  workspaceRoleOf(workspaceId: string, userId: string): Promise<WorkspaceRole | null> {
    return this.repo.workspaceRoleOf(workspaceId, userId);
  }

  /** Append a line to the access audit log (never updated, never deleted). */
  async audit(actor: Actor, e: AuditEntry) {
    const row: AuditInsert = {
      workspaceId: actor.workspaceId,
      teamId: e.teamId ?? null,
      actorKind: actor.kind,
      actorId: actor.id,
      actorName: actor.name,
      action: e.action,
      targetType: e.targetType,
      targetId: e.targetId ?? null,
      before: e.before ?? null,
      after: e.after ?? null,
    };
    await this.repo.insertAudit(row);
  }

  /** Why a person cannot leave the team, or null when they can. A retired team is always free to leave, unless the person is its last admin. */
  async leaveBlock(team: { id: string; workspaceId: string; retiredAt: Date | null }, userId: string): Promise<string | null> {
    const me = await this.repo.memberRole(team.id, userId);
    if (!me) return "You are not in this team";
    if (me.role === "admin" && (await this.repo.adminCount(team.id)) <= 1) return "A team needs at least one admin. Name another admin first.";
    if (!team.retiredAt) {
      // The one place both the leave guard and the "can leave?" state in the team settings read from, so the two cannot disagree.
      const active = await this.repo.activeTeamIdsOf(team.workspaceId, userId);
      if (!active.some((id) => id !== team.id)) return "This is the only active team you are on. Join or ask to be added to another team first.";
    }
    return null;
  }

  /** The ids of the active (not retired) teams a person is on. */
  activeTeamIdsOf(workspaceId: string, userId: string): Promise<string[]> {
    return this.repo.activeTeamIdsOf(workspaceId, userId);
  }

  /** Lock the workspace's team rows for the rest of the transaction, so two lifecycle changes to its teams run one after the other. */
  lockWorkspaceTeams(workspaceId: string) {
    return this.repo.lockWorkspaceTeams(workspaceId);
  }

  /** The teams a key or system actor is scoped to: the key's rows in `api_key_teams`, or the one team of a system actor. */
  private async scopedTeamIds(actor: Actor): Promise<string[]> {
    if (actor.system) return actor.teamId ? [actor.teamId] : [];
    return this.repo.scopedTeamIds(actor.id, actor.workspaceId);
  }
}
