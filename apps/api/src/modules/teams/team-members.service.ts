import { Inject, Injectable } from "@nestjs/common";
import { TEAM_ROLES, type TeamRole, type WorkspaceRole } from "../../db/schema";
import type { Actor } from "../../common/actor";
import { canManagePeople } from "../../common/roles";
import { ServiceError } from "../../common/service-error";
import { isUuid } from "../../common/uuid";
import { Database } from "../../platform/database/database";
import { EventsService } from "../../platform/events/events.service";
import { TeamAccessService } from "./team-access.service";
import { TeamsRepository } from "./teams.repository";
import { TeamsService } from "./teams.service";

/**
 * Who is in a team and how they got there (ADR-23). Everything here is for people: an agent key cannot add or remove members.
 * Each change is checked against the caller's role, keeps at least one admin on the team, and writes an audit line.
 */

export type TeamMemberView = { userId: string; name: string; email: string; role: TeamRole; workspaceRole: WorkspaceRole; addedAt: Date };
export type WorkspaceTeamView = { id: string; key: string; name: string; admins: string[]; memberCount: number; isMember: boolean };
export type AuditView = { seq: number; actorName: string; action: string; targetType: string; targetId: string | null; teamKey: string | null; before: unknown; after: unknown; createdAt: Date };

function people(actor: Actor) {
  if (actor.kind !== "human" || actor.system) throw new ServiceError("forbidden", "Only people can manage who is in a team");
}

const isTeamRole = (v: unknown): v is TeamRole => typeof v === "string" && (TEAM_ROLES as readonly string[]).includes(v);

@Injectable()
export class TeamMembersService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(TeamsRepository) private readonly repo: TeamsRepository,
    @Inject(TeamAccessService) private readonly access: TeamAccessService,
    @Inject(TeamsService) private readonly teams: TeamsService,
    @Inject(EventsService) private readonly events: EventsService,
  ) {}

  /**
   * The caller's teams, each with the caller's own role in it, in the order the person keeps them (see `setOrder`): the ones they
   * have placed first, in their order, then any they have not, oldest first. An agent key or the system gets creation order.
   */
  async listWithRole(actor: Actor) {
    // Retired teams come back too, flagged `retired`, so the sidebar can group them apart from the active ones.
    const [teams, roles] = await Promise.all([this.teams.list(actor, { includeRetired: true }), this.access.roleMap(actor)]);
    const placed = new Map<string, number>();
    if (actor.kind === "human" && !actor.system) {
      const rows = await this.repo.memberPositions(actor.id, actor.workspaceId);
      for (const r of rows) if (r.position !== null) placed.set(r.teamId, r.position);
    }
    const rank = (id: string) => placed.get(id) ?? Number.POSITIVE_INFINITY;
    return teams
      .map((p) => ({ ...p, role: (roles?.get(p.id) ?? "editor") as TeamRole, retired: !!p.retiredAt }))
      .sort((a, b) => (rank(a.id) === rank(b.id) ? a.createdAt.getTime() - b.createdAt.getTime() : rank(a.id) < rank(b.id) ? -1 : 1));
  }

  /**
   * Remember the order the person wants their teams in: `keys` first to last. It is theirs alone (their own `team_members` rows), so it
   * changes nothing for anyone else. A key that is not one of their teams is ignored, and a team left out keeps its place after the rest.
   */
  async setOrder(actor: Actor, keys: unknown) {
    people(actor);
    if (!Array.isArray(keys) || keys.length > 500 || keys.some((k) => typeof k !== "string")) {
      throw new ServiceError("invalid", "keys must be a list of team keys", { fields: { keys: "a list of team keys" } });
    }
    const mine = await this.teams.list(actor, { includeRetired: true });
    const byKey = new Map(mine.map((t) => [t.key.toUpperCase(), t.id]));
    const ids = [...new Set((keys as string[]).map((k) => byKey.get(k.toUpperCase())).filter((x): x is string => !!x))];
    await this.db.transaction(async () => {
      for (const [i, teamId] of ids.entries()) await this.repo.setMemberPosition(teamId, actor.id, actor.workspaceId, (i + 1) * 1000);
    });
    return { ok: true as const, placed: ids.length };
  }

  /** The team's members. Any member can see who else is in it. */
  async list(actor: Actor, teamRef: string) {
    const team = await this.access.require(actor, teamRef);
    const rows = await this.repo.teamMembers(team.id);
    return { team: { id: team.id, key: team.key, name: team.name }, myRole: await this.access.roleOn(actor, team.id), members: rows as TeamMemberView[] };
  }

  /** Workspace members who are not in the team yet, for the "add someone" list. Team admins only. */
  async listAddable(actor: Actor, teamRef: string) {
    people(actor);
    // A guest sees no directory of the workspace's people, even as a team admin.
    if ((await this.access.workspaceRoleOf(actor.workspaceId, actor.id)) === "guest") throw new ServiceError("forbidden", "Guests cannot see the workspace's people");
    const team = await this.access.require(actor, teamRef, "admin");
    return this.repo.addableMembers(actor.workspaceId, team.id);
  }

  /** Add a workspace member to the team. Team admins only; the person must already be in the workspace. */
  async add(actor: Actor, teamRef: string, input: { userId: string; role?: unknown }) {
    people(actor);
    if (!isTeamRole(input.role)) throw new ServiceError("invalid", "Choose a team role: admin, editor or viewer");
    const team = await this.access.require(actor, teamRef, "admin");
    if (!isUuid(input.userId)) throw new ServiceError("not_found", "That person is not in this workspace");
    const ws = await this.access.workspaceRoleOf(actor.workspaceId, input.userId);
    if (!ws) throw new ServiceError("not_found", "That person is not in this workspace");
    const role = input.role;
    return this.db.transaction(async () => {
      if (await this.repo.memberRole(team.id, input.userId)) throw new ServiceError("conflict", "They are already in this team");
      await this.repo.insertMember({ teamId: team.id, userId: input.userId, workspaceId: actor.workspaceId, role, addedBy: actor.id });
      await this.access.audit(actor, { action: "team.member_added", targetType: "user", targetId: input.userId, teamId: team.id, after: { role } });
      return { userId: input.userId, role };
    });
  }

  /** Change someone's role in the team. Team admins only; the last admin cannot be demoted. */
  async setRole(actor: Actor, teamRef: string, userId: string, roleIn: unknown) {
    people(actor);
    if (!isTeamRole(roleIn)) throw new ServiceError("invalid", "Choose a team role: admin, editor or viewer");
    const role = roleIn;
    const team = await this.access.require(actor, teamRef, "admin");
    if (!isUuid(userId)) throw new ServiceError("not_found", "They are not in this team");
    return this.db.transaction(async () => {
      const cur = await this.repo.memberRole(team.id, userId);
      if (!cur) throw new ServiceError("not_found", "They are not in this team");
      if (cur.role === role) return { userId, role };
      if (cur.role === "admin" && (await this.repo.adminCount(team.id)) <= 1) throw new ServiceError("conflict", "A team needs at least one admin. Name another admin first.");
      await this.repo.setMemberRole(team.id, userId, role);
      await this.access.audit(actor, { action: "team.member_role_changed", targetType: "user", targetId: userId, teamId: team.id, before: { role: cur.role }, after: { role } });
      return { userId, role };
    });
  }

  /** Remove someone from the team, or leave it yourself. Team admins only (anyone may leave); the last admin cannot go. */
  async remove(actor: Actor, teamRef: string, userId: string) {
    people(actor);
    const team = await this.access.require(actor, teamRef, userId === actor.id ? "read" : "admin");
    if (!isUuid(userId)) throw new ServiceError("not_found", "They are not in this team");
    return this.db.transaction(async () => {
      // Leaving yourself also keeps you on one active team; the lock makes two leaves at once check one after the other.
      if (userId === actor.id) await this.access.lockWorkspaceTeams(team.workspaceId);
      const cur = await this.repo.memberRole(team.id, userId);
      if (!cur) throw new ServiceError("not_found", "They are not in this team");
      if (userId === actor.id) {
        const fresh = (await this.repo.teamById(team.id))!;
        const why = await this.access.leaveBlock(fresh, userId);
        if (why) throw new ServiceError("conflict", why);
      } else if (cur.role === "admin" && (await this.repo.adminCount(team.id)) <= 1) throw new ServiceError("conflict", "A team needs at least one admin. Name another admin first.");
      await this.repo.deleteMember(team.id, userId);
      await this.access.audit(actor, { action: userId === actor.id ? "team.member_left" : "team.member_removed", targetType: "user", targetId: userId, teamId: team.id, before: { role: cur.role } });
      return { ok: true as const };
    });
  }

  /**
   * Every team of the workspace by name, with who administers it and whether you are in it: the list an owner or admin
   * uses to find a team to join. Nothing inside a team is visible from here. Owners and admins only.
   */
  async listWorkspaceTeams(actor: Actor): Promise<WorkspaceTeamView[]> {
    people(actor);
    const ws = await this.access.workspaceRoleOf(actor.workspaceId, actor.id);
    if (!ws || !canManagePeople(ws)) throw new ServiceError("forbidden", "Only workspace owners and admins can see every team");
    const ps = await this.repo.workspaceTeamsByCreation(actor.workspaceId);
    const rows = await this.repo.workspaceMemberRows(actor.workspaceId);
    return ps.map((p) => {
      const mine = rows.filter((r) => r.teamId === p.id);
      return { id: p.id, key: p.key, name: p.name, admins: mine.filter((r) => r.role === "admin").map((r) => r.name), memberCount: mine.length, isMember: mine.some((r) => r.userId === actor.id) };
    });
  }

  /**
   * An owner or admin of the workspace joins a team as its admin, for example to recover one whose admins left. Never silent:
   * it writes an audit line and a line in the team's own activity, so its members see who came in and when.
   */
  async joinAsWorkspaceAdmin(actor: Actor, teamRef: string) {
    people(actor);
    const ws = await this.access.workspaceRoleOf(actor.workspaceId, actor.id);
    if (!ws || !canManagePeople(ws)) throw new ServiceError("forbidden", "Only workspace owners and admins can join a team");
    const team = await this.access.find(actor, teamRef);
    if (!team) throw new ServiceError("not_found", `Team ${teamRef} not found`);
    return this.db.transaction(async () => {
      if (await this.repo.memberRole(team.id, actor.id)) throw new ServiceError("conflict", "You are already in this team");
      await this.repo.insertMember({ teamId: team.id, userId: actor.id, workspaceId: actor.workspaceId, role: "admin", addedBy: actor.id });
      await this.access.audit(actor, { action: "team.admin_joined", targetType: "user", targetId: actor.id, teamId: team.id, after: { role: "admin", workspaceRole: ws } });
      await this.events.emit(actor, team.id, { type: "team.admin_joined", entity: "team", entityId: team.id, summary: `${actor.name} (workspace ${ws}) joined ${team.key} as admin` });
      return { team: { id: team.id, key: team.key, name: team.name } };
    });
  }

  /** The access audit log, newest first. Owners and admins only; `teamRef` narrows it to one team they can name. */
  async listAudit(actor: Actor, opts: { teamRef?: string; limit?: number } = {}): Promise<AuditView[]> {
    people(actor);
    const ws = await this.access.workspaceRoleOf(actor.workspaceId, actor.id);
    if (!ws || !canManagePeople(ws)) throw new ServiceError("forbidden", "Only workspace owners and admins can read the audit log");
    let teamId: string | undefined;
    if (opts.teamRef) {
      const p = await this.access.find(actor, opts.teamRef);
      if (!p) throw new ServiceError("not_found", `Team ${opts.teamRef} not found`);
      teamId = p.id;
    }
    const limit = Number.isFinite(opts.limit) ? Math.min(Math.max(Math.trunc(opts.limit!), 1), 500) : 100;
    const rows = await this.repo.auditRows(actor.workspaceId, teamId, limit);
    return rows.map(({ a: r, key }) => ({ seq: r.seq, actorName: r.actorName, action: r.action, targetType: r.targetType, targetId: r.targetId, teamKey: key, before: r.before, after: r.after, createdAt: r.createdAt }));
  }
}
