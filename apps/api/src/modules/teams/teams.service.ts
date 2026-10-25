import { Inject, Injectable } from "@nestjs/common";
import { DEFAULT_STATUS_DEFS } from "@wheelhouse/shared/status-roles";
import type { Actor } from "../../common/actor";
import { ServiceError } from "../../common/service-error";
import { removeSession } from "../../lib/service-queue";
import { Database } from "../../platform/database/database";
import { EventsService } from "../../platform/events/events.service";
import { TeamAccessService } from "./team-access.service";
import { TeamLifecycleService } from "./team-lifecycle.service";
import { TeamsRepository, type TeamRow } from "./teams.repository";
import { parseTeamIcon, parseTeamIconColor } from "./team-icon";

/** Teams themselves: the list, create, rename and delete. Their lifecycle, members and statuses are the sibling services. */
@Injectable()
export class TeamsService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(TeamsRepository) private readonly repo: TeamsRepository,
    @Inject(TeamAccessService) private readonly access: TeamAccessService,
    @Inject(TeamLifecycleService) private readonly lifecycle: TeamLifecycleService,
    @Inject(EventsService) private readonly events: EventsService,
  ) {}

  /** The teams the actor can open: a person's own teams, or the teams an agent key is scoped to (ADR-23, WH-120). */
  async list(actor: Actor, opts: { includeRetired?: boolean } = {}): Promise<TeamRow[]> {
    const visible = await this.access.visibleTeamIds(actor);
    if (visible && !visible.length) return [];
    return this.repo.listTeams(actor.workspaceId, visible, !!opts.includeRetired);
  }

  /** The key defaults from the name; a taken key is a conflict. The creator becomes the team's first admin. */
  async create(actor: Actor, input: { name: string; key?: string; description?: string; parent?: string | null }): Promise<TeamRow> {
    const name = input.name.trim();
    if (!name) throw new ServiceError("invalid", "Team name is required");
    // Workspace Viewers and Guests cannot start teams (ADR-23); agent keys can still create them.
    if (actor.kind === "human") {
      const ws = await this.access.workspaceRoleOf(actor.workspaceId, actor.id);
      if (ws !== "owner" && ws !== "admin" && ws !== "member") throw new ServiceError("forbidden", "Your workspace role cannot create teams");
    }
    const key = (input.key || name.replace(/[^a-zA-Z]/g, "").slice(0, 3) || "PRJ").toUpperCase().slice(0, 6);
    if (await this.repo.keyTaken(actor.workspaceId, key)) throw new ServiceError("conflict", `Team key ${key} already in use`);

    return this.db.transaction(async () => {
      // A parent must be a team of this workspace that the creator can open; it grants nothing in either direction.
      const parent = input.parent ? await this.lifecycle.resolveParent(actor, null, input.parent) : null;
      const p = await this.repo.insertTeam({ workspaceId: actor.workspaceId, name, key, description: input.description ?? "", parentId: parent?.id ?? null });
      await this.repo.insertDefaultStatuses(p, DEFAULT_STATUS_DEFS);
      // The creator becomes the team's first admin: without a row here nobody could open the team they just made.
      if (actor.kind === "human") {
        await this.repo.insertMember({ teamId: p.id, userId: actor.id, workspaceId: actor.workspaceId, role: "admin", addedBy: actor.id });
        await this.access.audit(actor, { action: "team.created", targetType: "team", targetId: p.id, teamId: p.id, after: { key: p.key, creatorRole: "admin", ...(parent ? { parentKey: parent.key } : {}) } });
      } else if (!actor.system) {
        // A key that makes a team is scoped to it, or it could not open what it just made (WH-120).
        await this.repo.scopeKeyTo(actor.id, p.id, p.workspaceId);
      }
      await this.events.emit(actor, p.id, { type: "team.created", entity: "team", entityId: p.id, summary: `created team ${p.name}` });
      return p;
    });
  }

  /** Rename a team and/or change its description. Team admins only; the key never changes (issues are named after it). */
  async update(actor: Actor, ref: string, input: { name?: string; description?: string; icon?: unknown; iconColor?: unknown }): Promise<TeamRow> {
    if (actor.kind !== "human") throw new ServiceError("forbidden", "Only teammates can edit a team's settings");
    const p = await this.access.require(actor, ref, "admin");
    const name = input.name === undefined ? p.name : input.name.trim();
    if (!name) throw new ServiceError("invalid", "Team name is required");
    const description = input.description === undefined ? p.description : input.description.trim();
    const icon = parseTeamIcon(input.icon);
    const iconColor = parseTeamIconColor(input.iconColor);
    const next = { name, description, icon: icon === undefined ? p.icon : icon, iconColor: iconColor === undefined ? p.iconColor : iconColor };
    if (next.name === p.name && next.description === p.description && next.icon === p.icon && next.iconColor === p.iconColor) return p;
    return this.db.transaction(async () => {
      const row = await this.repo.updateTeam(p.id, next);
      await this.access.audit(actor, { action: "team.updated", targetType: "team", targetId: p.id, teamId: p.id, before: { name: p.name, icon: p.icon, iconColor: p.iconColor }, after: { name, icon: next.icon, iconColor: next.iconColor } });
      await this.events.emit(actor, p.id, { type: "team.updated", entity: "team", entityId: p.id, summary: `updated the settings of team ${row.name}` });
      return row;
    });
  }

  /** Delete a team and everything in it (issues, map, flows, drafts, sessions, activity). Teammates only. */
  async delete(actor: Actor, ref: string) {
    if (actor.kind !== "human") throw new ServiceError("forbidden", "Only teammates can delete a team");
    const found = await this.access.require(actor, ref, "admin");
    const p = await this.db.transaction(async () => {
      // Lock the workspace's teams, then count: two admins deleting the last two teams at once cannot both succeed.
      await this.access.lockWorkspaceTeams(found.workspaceId);
      const p = await this.repo.teamById(found.id);
      if (!p) throw new ServiceError("not_found", `Team ${ref} not found`);
      // The last active team stays, a team that leads a live project waits until someone else leads it, and child teams go or move first.
      const why = await this.lifecycle.deleteBlock(actor, p);
      if (why) throw new ServiceError("conflict", why);
      // A deleted project the team led goes for good with it.
      await this.repo.deleteProjectsLedBy(p.id);
      await this.access.audit(actor, { action: "team.deleted", targetType: "team", targetId: p.id, teamId: p.id, before: { key: p.key, name: p.name, retired: !!p.retiredAt } });
      // events has no foreign key to teams, so clear it explicitly; everything else cascades.
      await this.repo.deleteEventsOf(p.id);
      await this.repo.deleteTeam(p.id);
      return p;
    });
    return { ok: true, deleted: p.key };
  }

  /** Teammates remove an agent session from a team (soft delete: if it reconnects it starts at the top of the queue). The agent queue is not converted yet. */
  removeSession(...a: Parameters<typeof removeSession>) {
    return removeSession(...a);
  }
}
