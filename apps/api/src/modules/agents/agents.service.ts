import { Inject, Injectable } from "@nestjs/common";
import { CATALOG } from "@wheelhouse/shared/agents/catalog/index";
import { GUARDRAILS, GUARDRAILS_VERSION } from "@wheelhouse/shared/agents/guardrails";
import { agentName, toSubagentFile } from "@wheelhouse/shared/agents/render";
import type { AgentProfile } from "@wheelhouse/shared/agents/schema";
import type { Actor } from "../../common/actor";
import { assertWritable, canManagePeople } from "../../common/roles";
import { ServiceError } from "../../common/service-error";
import { Database } from "../../platform/database/database";
import { EventsService } from "../../platform/events/events.service";
import { TeamAccessService } from "../teams/index";
import { AgentsRepository, type AgentRow } from "./agents.repository";
import { agentView, catalogView, customView, effectiveProfile } from "./agents.presenter";

/**
 * Agents: the Wheelhouse catalog, the workspace's own agents, and each team's roster (docs/agents-plan.md). The catalog is code and a
 * workspace only stores a pin; a custom agent is a full profile. Workspace admins (owners and admins) manage the workspace's agents and
 * pins; a team's admin manages its roster and its own team agents. Everything answers "off" while the workspace switch is off.
 * Teams are opened through TeamAccessService, so a team the person is not on is a 404 even for a workspace admin (ADR-23).
 */

const off = () => new ServiceError("not_found", "Agents are off for this workspace");

@Injectable()
export class AgentsService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(AgentsRepository) private readonly repo: AgentsRepository,
    @Inject(TeamAccessService) private readonly access: TeamAccessService,
    @Inject(EventsService) private readonly events: EventsService,
  ) {}

  /** The person behind a request: agents are managed by people only. `admin`: a workspace owner or admin. */
  private async who(actor: Actor) {
    const role = actor.kind === "human" && !actor.system ? await this.access.workspaceRoleOf(actor.workspaceId, actor.id) : null;
    if (!role) throw new ServiceError("forbidden", "Only teammates can manage agents");
    return { admin: canManagePeople(role) };
  }

  private async requireEnabled(actor: Actor) {
    if (!(await this.repo.agentsEnabled(actor.workspaceId))) throw off();
  }

  private requireAdmin(admin: boolean) {
    if (!admin) throw new ServiceError("forbidden", "Only workspace owners and admins can do that");
  }

  /** A team of the workspace the person can open and change the roster of: a workspace admin, or that team's admin. */
  private async teamToManage(actor: Actor, key: string, admin: boolean) {
    const team = await this.access.require(actor, key, "read");
    assertWritable(team);
    if (!admin && (await this.access.roleOn(actor, team.id)) !== "admin") throw new ServiceError("forbidden", "Only a workspace admin or the team's admin can do that");
    return team;
  }

  /** A custom agent of the workspace by slug. A team agent of a team the person cannot open is not there. */
  private async customAgent(actor: Actor, slug: string): Promise<AgentRow> {
    if (CATALOG[slug]) throw new ServiceError("invalid", "A catalog agent's profile and face are Wheelhouse's; pin a version instead");
    const row = await this.repo.agentBySlug(actor.workspaceId, slug);
    if (!row || (row.teamId && !(await this.access.roleOn(actor, row.teamId)))) throw new ServiceError("not_found", `Agent ${slug} not found`);
    return row;
  }

  /** The catalog row of a workspace for `slug`, made on first use. */
  private async catalogRow(actor: Actor, slug: string): Promise<AgentRow> {
    const row = await this.repo.agentBySlug(actor.workspaceId, slug);
    if (row) return row;
    await this.repo.insertAgent({ workspaceId: actor.workspaceId, slug, source: "catalog", catalogSlug: slug, createdBy: actor.id, updatedBy: actor.id });
    return (await this.repo.agentBySlug(actor.workspaceId, slug))!;
  }

  /** The Wheelhouse guardrails every agent is rendered with. */
  async guardrails(actor: Actor) {
    await this.requireEnabled(actor);
    return { version: GUARDRAILS_VERSION, text: GUARDRAILS };
  }

  /** The catalog and the workspace's own agents (team agents only for teams the person can open), each custom one with what the person may do to it. */
  async list(actor: Actor) {
    const { admin } = await this.who(actor);
    if (!(await this.repo.agentsEnabled(actor.workspaceId))) return { enabled: false, catalog: [], workspace: [] };
    const rows = await this.repo.agentRows(actor.workspaceId);
    const roles = await this.access.roleMap(actor);
    const onTeams = new Map<string, string[]>();
    for (const r of await this.repo.rosterTeams(actor.workspaceId)) onTeams.set(r.agentId, [...(onTeams.get(r.agentId) ?? []), r.teamId]);
    const catalog = Object.keys(CATALOG).map((slug) => catalogView(slug, rows.find((r) => r.slug === slug)));
    const workspace = rows
      .filter((r) => r.source === "custom" && (!r.teamId || roles.has(r.teamId)))
      .map((r) => {
        const edit = admin || r.createdBy === actor.id;
        const teamAdmin = [...(onTeams.get(r.id) ?? []), ...(r.teamId ? [r.teamId] : [])].some((id) => roles.get(id) === "admin");
        return { ...customView(r), can: { edit, face: edit || teamAdmin } };
      });
    return { enabled: true, catalog, workspace };
  }

  /** Every version of a catalog agent, newest first. The catalog keeps no changelog yet, so only the first version has a line. */
  async versions(actor: Actor, slug: string) {
    await this.who(actor);
    await this.requireEnabled(actor);
    const versions = CATALOG[slug];
    if (!versions) throw new ServiceError("not_found", `Catalog agent ${slug} not found`);
    return versions.map((p, i) => ({ version: i + 1, summary: p.summary, changelog: i === 0 ? "First version" : "" })).reverse();
  }

  /** `{ version }` pins a catalog agent's version for the workspace; null follows the latest. Workspace admins only. */
  async pin(actor: Actor, slug: string, version: number | null) {
    const { admin } = await this.who(actor);
    this.requireAdmin(admin);
    await this.requireEnabled(actor);
    const versions = CATALOG[slug];
    if (!versions) throw new ServiceError("not_found", `Catalog agent ${slug} not found`);
    if (version !== null && version > versions.length) throw new ServiceError("invalid", `${slug} has ${versions.length} version${versions.length === 1 ? "" : "s"}`, { fields: { version: "No such version" } });
    const row = await this.catalogRow(actor, slug);
    return catalogView(slug, await this.repo.updateAgent(row.id, { pinnedVersion: version, updatedBy: actor.id }));
  }

  /** A new custom agent. Without `teamKey` it is workspace-wide (workspace admins) and any team may add it; with it, that team's own (its admin or a workspace admin), put on its roster. */
  async create(actor: Actor, input: { profile: AgentProfile; teamKey?: string }) {
    const { admin } = await this.who(actor);
    await this.requireEnabled(actor);
    const team = input.teamKey ? await this.teamToManage(actor, input.teamKey, admin) : null;
    if (!team) this.requireAdmin(admin);
    const { profile } = input;
    if (CATALOG[profile.slug] || (await this.repo.agentBySlug(actor.workspaceId, profile.slug))) {
      throw new ServiceError("conflict", `The slug "${profile.slug}" is taken`, { fields: { "profile.slug": "already taken" } });
    }
    return this.db.transaction(async () => {
      const row = await this.repo.insertAgent({ workspaceId: actor.workspaceId, teamId: team?.id ?? null, slug: profile.slug, source: "custom", profile, createdBy: actor.id, updatedBy: actor.id });
      if (team) await this.addToTeam(actor, team, row, profile);
      return { ...customView((await this.repo.agentBySlug(actor.workspaceId, profile.slug))!), can: { edit: true, face: true } };
    });
  }

  /** `{ profile }`: its creator or a workspace admin. `{ avatar }`: also a team admin of a team it is on. Custom agents only; the slug never changes. */
  async update(actor: Actor, slug: string, input: { profile?: AgentProfile; avatar?: AgentProfile["avatar"] }) {
    const { admin } = await this.who(actor);
    await this.requireEnabled(actor);
    const row = await this.customAgent(actor, slug);
    const creator = row.createdBy === actor.id;
    let allowed = admin || creator;
    if (input.avatar && !allowed) {
      const roles = await this.access.roleMap(actor);
      const teamIds = [...(await this.repo.rosterTeams(actor.workspaceId)).filter((r) => r.agentId === row.id).map((r) => r.teamId), ...(row.teamId ? [row.teamId] : [])];
      allowed = teamIds.some((id) => roles.get(id) === "admin");
    }
    if (!allowed) throw new ServiceError("forbidden", input.avatar ? "Only its creator, a workspace admin or an admin of a team it is on can change its face" : "Only its creator or a workspace admin can edit it");
    const profile = input.profile ?? { ...effectiveProfile(row), avatar: input.avatar! };
    if (profile.slug !== slug) throw new ServiceError("invalid", "An agent's slug cannot change", { fields: { "profile.slug": "cannot change" } });
    const saved = await this.repo.updateAgent(row.id, { profile, version: row.version + 1, updatedBy: actor.id });
    return { ...customView({ ...saved, teamKey: row.teamKey }), can: { edit: admin || creator, face: true } };
  }

  /** Deletes a custom agent and takes it off every roster. Its creator or a workspace admin. */
  async remove(actor: Actor, slug: string) {
    const { admin } = await this.who(actor);
    await this.requireEnabled(actor);
    const row = await this.customAgent(actor, slug);
    if (!admin && row.createdBy !== actor.id) throw new ServiceError("forbidden", "Only its creator or a workspace admin can delete it");
    await this.repo.deleteAgent(row.id);
    return { ok: true };
  }

  /** The team's agents, as members see them; empty while agents are off. */
  async roster(actor: Actor, teamKey: string) {
    await this.who(actor);
    const team = await this.access.require(actor, teamKey, "read");
    if (!(await this.repo.agentsEnabled(actor.workspaceId))) return { agents: [] };
    // `id` lets an issue's delegate (a workspace agent id, WH-113) be matched to its roster entry.
    return { agents: (await this.repo.roster(team.id)).map((r) => ({ ...agentView(r), id: r.id })) };
  }

  /** `{ slug }`: puts a catalog agent, a workspace-wide agent or this team's own agent on the roster. Another team's agent is a 400. */
  async addToRoster(actor: Actor, teamKey: string, slug: string) {
    const { admin } = await this.who(actor);
    await this.requireEnabled(actor);
    const team = await this.teamToManage(actor, teamKey, admin);
    const found = await this.repo.agentBySlug(actor.workspaceId, slug);
    if (!found && !CATALOG[slug]) throw new ServiceError("not_found", `Agent ${slug} not found`);
    if (found?.teamId && found.teamId !== team.id) throw new ServiceError("invalid", "A team agent cannot be added to another team", { fields: { slug: "belongs to another team" } });
    return this.db.transaction(async () => {
      const row = found ?? (await this.catalogRow(actor, slug));
      if (!(await this.addToTeam(actor, team, row, effectiveProfile(row)))) throw new ServiceError("conflict", `${slug} is already on this team`);
      return agentView((await this.repo.agentBySlug(actor.workspaceId, slug))!);
    });
  }

  async removeFromRoster(actor: Actor, teamKey: string, slug: string) {
    const { admin } = await this.who(actor);
    await this.requireEnabled(actor);
    const team = await this.teamToManage(actor, teamKey, admin);
    const row = await this.repo.agentBySlug(actor.workspaceId, slug);
    if (!row || !(await this.repo.removeFromRoster(team.id, row.id))) throw new ServiceError("not_found", `${slug} is not on this team`);
    const p = effectiveProfile(row);
    await this.events.emit(actor, team.id, { type: "team.agent_removed", entity: "team", entityId: team.id, summary: `removed ${p.name} (${p.role}) from the team`, data: { slug } });
    return { ok: true };
  }

  /** For the plugin: the team's agents as Claude Code subagent files. Any actor that can open the team (an agent key scoped to it); empty while agents are off. */
  async subagentFiles(actor: Actor, teamKey: string) {
    const team = await this.access.require(actor, teamKey, "read");
    if (!(await this.repo.agentsEnabled(actor.workspaceId))) return { files: [] };
    const files = (await this.repo.roster(team.id)).map((r) => effectiveProfile(r)).map((p) => ({ name: `${agentName(p)}.md`, content: toSubagentFile(p) }));
    return { files };
  }

  private async addToTeam(actor: Actor, team: { id: string; workspaceId: string }, row: Pick<AgentRow, "id" | "slug">, p: AgentProfile): Promise<boolean> {
    if (!(await this.repo.addToRoster(team, row.id, actor.id))) return false;
    await this.events.emit(actor, team.id, { type: "team.agent_added", entity: "team", entityId: team.id, summary: `added ${p.name} (${p.role}) to the team`, data: { slug: row.slug } });
    return true;
  }
}
