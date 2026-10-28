import { Inject, Injectable } from "@nestjs/common";
import * as schema from "../../../db/schema";
import type { Priority, ProjectStatus, TeamRole } from "../../../db/schema";
import type { Actor } from "../../../common/actor";
import { ServiceError } from "../../../common/service-error";
import { roleAllows } from "../../../common/roles";
import { isUuid } from "../../../common/uuid";
import { avatarUrl } from "../../images/index";
import { Database } from "../../../platform/database/database";
import { EventsService } from "../../../platform/events/events.service";
import { TeamAccessService } from "../../teams/index";
import { IssueTargets } from "../issue-targets";
import { ProjectsRepository, type ProjectRow } from "./projects.repository";
import { STATUS_ORDER, bad, day, healthOf, oneOf, positionBetween, targetInputs, text, type HealthView, type MilestoneInput, type ProgressCounts, type ProjectInput } from "../issues.rules";

/**
 * Projects (WH-118): an outcome that ends and can span teams, with a lead, dates, milestones and a health worked out from its
 * issues and dates unless someone sets it. A project belongs to the workspace and is seen only by people on a team that takes part
 * (plan section 5): issue detail only for the viewer's own teams, and for the other teams just totals, never names or titles.
 * Guests see no projects. The database holds the other rules: an issue reaches a project only through its own team's row in
 * project_teams, a milestone belongs to that project, and the lead team takes part.
 */

export type { ProjectRow };

type Access = {
  project: ProjectRow;
  /** The teams of the project the person is on, with their role there. */
  mine: Map<string, TeamRole>;
  /** All the teams taking part. */
  teamIds: string[];
  canEdit: boolean;
  canAdmin: boolean;
};

export type ProjectSummary = {
  id: string;
  name: string;
  description: string;
  status: ProjectStatus;
  priority: Priority;
  health: HealthView;
  startDate: string | null;
  targetDate: string | null;
  leadUser: { id: string; name: string; avatarUrl: string | null } | null;
  /** Named only for someone on the lead team: others are told nothing about teams they are not on. */
  leadTeam: { key: string; name: string } | null;
  /** Every issue in the project, across all the teams, and how many are done. */
  total: number;
  done: number;
  teamCount: number;
  version: number;
  canEdit: boolean;
  updatedAt: Date;
};

export type ProjectMilestoneView = { id: string; name: string; description: string; targetDate: string | null; position: number; total: number; done: number };
export type ProjectIssueView = { ref: string; title: string; priority: string; status: string; done: boolean; milestoneId: string | null };
export type ProjectTeamView = { key: string; name: string; role: TeamRole; lead: boolean; total: number; done: number; issues: ProjectIssueView[] };
export type ProjectDetail = ProjectSummary & {
  canAdmin: boolean;
  /** WH-135: where the project's work happens; the fallback for its issues' targets. */
  repositories: { repositoryId: string; repository: string; branch: string }[];
  milestones: ProjectMilestoneView[];
  /** The teams of the project the viewer is on, with their issues. */
  teams: ProjectTeamView[];
  /** The teams they are not on: how many, and the totals of their issues. Never a name or a title. */
  others: { count: number; total: number; done: number };
  /** Teams the viewer could bring in (they edit them) and that do not take part yet. */
  addableTeams: { key: string; name: string }[];
};

export type IssueProjectChoice = { projectId: string | null; milestoneId: string | null };

/** The projects a team takes part in, with their milestones, for the board's chips and the issue's Project field. */
export type TeamProjectOption = { id: string; name: string; status: ProjectStatus; milestones: { id: string; name: string }[] };

type EventInput = { type: string; entityId: string; summary: string; data?: Record<string, unknown>; entity?: "project" | "initiative" };

/** Teammates and API keys work with projects; Wheelhouse's own system work does not. */
function humanOnly(actor: Actor) {
  if (actor.system) throw new ServiceError("forbidden", "Only teammates and API keys work with projects");
}

@Injectable()
export class ProjectsService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(ProjectsRepository) private readonly repo: ProjectsRepository,
    @Inject(TeamAccessService) private readonly access: TeamAccessService,
    @Inject(EventsService) private readonly events: EventsService,
    @Inject(IssueTargets) private readonly targets: IssueTargets,
  ) {}

  // ───────── who may do what ─────────

  private async notGuest(actor: Actor) {
    if (actor.kind === "agent") return; // a key reaches the teams it was given, never a guest's view
    const role = await this.access.workspaceRoleOf(actor.workspaceId, actor.id);
    if (!role || role === "guest") throw new ServiceError("not_found", "Project not found");
  }

  /**
   * Open a project for a person: they must be on a team that takes part (a guest never is, and a project of another workspace, a
   * deleted one and one they cannot see all answer not_found). Editing needs the project lead, or an editor or admin of the lead team;
   * "admin" (the lead, the lead team, deleting) needs the project lead or an admin of the lead team.
   */
  async openProject(actor: Actor, id: string, need: "read" | "edit" | "admin" = "read"): Promise<Access> {
    humanOnly(actor);
    const notFound = () => new ServiceError("not_found", "Project not found");
    if (!isUuid(id)) throw notFound();
    await this.notGuest(actor);
    const project = await this.repo.findLive(actor.workspaceId, id);
    if (!project) throw notFound();
    const teamIds = await this.repo.teamIdsOf(id);
    const roles = await this.access.roleMap(actor);
    const mine = new Map(teamIds.flatMap((t) => (roles.has(t) ? [[t, roles.get(t)!] as const] : [])));
    if (!mine.size) throw notFound();
    const isLead = project.leadUserId === actor.id;
    const leadRole = mine.get(project.leadTeamId);
    const canEdit = isLead || (!!leadRole && roleAllows(leadRole, "edit"));
    const canAdmin = isLead || (!!leadRole && roleAllows(leadRole, "admin"));
    if (need === "edit" && !canEdit) throw new ServiceError("forbidden", "Only the project lead, or an editor of the lead team, can change a project");
    if (need === "admin" && !canAdmin) throw new ServiceError("forbidden", "Only the project lead, or an admin of the lead team, can do that");
    return { project, mine, teamIds, canEdit, canAdmin };
  }

  // ───────── events ─────────

  /** A line in the workspace's own log (projects and initiatives). */
  async workspaceEvent(actor: Actor, e: EventInput) {
    await this.repo.insertWorkspaceEvent({
      workspaceId: actor.workspaceId,
      actorKind: actor.kind,
      actorId: actor.id,
      actorName: actor.name,
      type: e.type,
      entity: e.entity ?? "project",
      entityId: e.entityId,
      summary: e.summary,
      data: e.data ?? {},
    });
  }

  /** What matters to a team goes into that team's own log too, which is what its agents read. */
  private async teamEvents(actor: Actor, teamIds: string[], e: { type: string; entityId: string; summary: string; data?: Record<string, unknown> }) {
    for (const teamId of teamIds) await this.events.emit(actor, teamId, { ...e, entity: "project" });
  }

  /** The issue joined or left a project: said to the issue's team, whose agents read that log. */
  async emitIssueMove(actor: Actor, teamId: string, ref: string, from: string | null, to: string | null) {
    if (from === to) return;
    const ids = [from, to].filter((x): x is string => !!x);
    const names = new Map((await this.repo.namesOf(ids)).map((p) => [p.id, p.name]));
    if (from) await this.events.emit(actor, teamId, { type: "project.issue_left", entity: "project", entityId: from, summary: `${ref} left project "${names.get(from) ?? ""}"`, data: { ref, project: names.get(from) ?? null } });
    if (to) await this.events.emit(actor, teamId, { type: "project.issue_joined", entity: "project", entityId: to, summary: `${ref} joined project "${names.get(to) ?? ""}"`, data: { ref, project: names.get(to) ?? null } });
  }

  // ───────── reading ─────────

  /** Per project, its issues and how many are done (a canceled issue is not counted); a project with none has zeros. */
  async progressOf(projectIds: string[]): Promise<Map<string, ProgressCounts>> {
    const out = new Map<string, ProgressCounts>(projectIds.map((id) => [id, { total: 0, done: 0 }]));
    if (!projectIds.length) return out;
    for (const r of await this.repo.progress(projectIds)) out.set(r.projectId!, { total: Number(r.total), done: Number(r.done) });
    return out;
  }

  /** The ids of the projects the person sees. */
  visibleProjectIds(userId: string) {
    return this.repo.visibleIds(userId);
  }

  projectsByIds(ids: string[]) {
    return this.repo.byIds(ids);
  }

  /** Id and name of the live projects the person sees. */
  visibleProjectNames(actor: Actor) {
    return this.repo.visibleNames(actor.workspaceId, actor.id);
  }

  private async summarise(actor: Actor, rows: ProjectRow[], now: Date): Promise<ProjectSummary[]> {
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const progress = await this.progressOf(ids);
    const roles = await this.access.roleMap(actor);
    const leadIds = [...new Set(rows.map((r) => r.leadUserId).filter((x): x is string => !!x))];
    const lead = new Map((leadIds.length ? await this.repo.usersByIds(leadIds) : []).map((u) => [u.id, u]));
    const teamRows = await this.repo.teamsByIds([...new Set(rows.map((r) => r.leadTeamId))]);
    const teamById = new Map(teamRows.map((t) => [t.id, t]));
    const nTeams = new Map((await this.repo.teamCounts(ids)).map((c) => [c.projectId, Number(c.n)]));
    return rows.map((p) => {
      const pr = progress.get(p.id)!;
      const leadRole = roles.get(p.leadTeamId);
      const t = leadRole ? teamById.get(p.leadTeamId) : undefined;
      return {
        id: p.id,
        name: p.name,
        description: p.description,
        status: p.status,
        priority: p.priority,
        health: healthOf(p, pr, now),
        startDate: p.startDate,
        targetDate: p.targetDate,
        leadUser: p.leadUserId && lead.has(p.leadUserId) ? { id: p.leadUserId, name: lead.get(p.leadUserId)!.name, avatarUrl: avatarUrl(p.leadUserId, lead.get(p.leadUserId)!.avatarKey) } : null,
        leadTeam: t ? { key: t.key, name: t.name } : null,
        total: pr.total,
        done: pr.done,
        teamCount: nTeams.get(p.id) ?? 0,
        version: p.version,
        canEdit: p.leadUserId === actor.id || (!!leadRole && roleAllows(leadRole, "edit")),
        updatedAt: p.updatedAt,
      };
    });
  }

  /** The projects the person can see (through `project_visibility`), active ones first. A guest sees none. */
  async listProjects(actor: Actor, now = new Date()): Promise<ProjectSummary[]> {
    humanOnly(actor);
    const role = await this.access.workspaceRoleOf(actor.workspaceId, actor.id);
    if (!role || role === "guest") return [];
    const list = await this.summarise(actor, await this.repo.visibleTo(actor.workspaceId, actor.id), now);
    return list.sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.name.localeCompare(b.name));
  }

  async getProject(actor: Actor, id: string, now = new Date()): Promise<ProjectDetail> {
    const a = await this.openProject(actor, id);
    const [summary] = await this.summarise(actor, [a.project], now);
    const counts = new Map((await this.repo.progressByTeam(id)).map((r) => [r.teamId, { total: Number(r.total), done: Number(r.done) }]));
    const teamRows = await this.repo.teamsByIds(a.teamIds);
    const mineRows = teamRows.filter((t) => a.mine.has(t.id)).sort((x, y) => x.key.localeCompare(y.key));
    const mineIds = mineRows.map((t) => t.id);
    const mineIssues = mineIds.length ? await this.repo.issuesOfTeams(id, mineIds) : [];
    const teamViews: ProjectTeamView[] = mineRows.map((t) => ({
      key: t.key,
      name: t.name,
      role: a.mine.get(t.id)!,
      lead: t.id === a.project.leadTeamId,
      total: counts.get(t.id)?.total ?? 0,
      done: counts.get(t.id)?.done ?? 0,
      issues: mineIssues.filter((x) => x.teamId === t.id).map((x) => ({ ref: `${t.key}-${x.number}`, title: x.title, priority: x.priority, status: x.status, done: x.role === "done", milestoneId: x.milestoneId })),
    }));
    const otherIds = a.teamIds.filter((t) => !a.mine.has(t));
    const others = otherIds.reduce((acc, t) => ({ count: acc.count + 1, total: acc.total + (counts.get(t)?.total ?? 0), done: acc.done + (counts.get(t)?.done ?? 0) }), { count: 0, total: 0, done: 0 });
    const byMs = new Map((await this.repo.progressByMilestone(id)).map((r) => [r.milestoneId, r]));
    const milestones = (await this.repo.milestonesOf(id)).map((m) => ({
      id: m.id,
      name: m.name,
      description: m.description,
      targetDate: m.targetDate,
      position: m.position,
      total: Number(byMs.get(m.id)?.total ?? 0),
      done: Number(byMs.get(m.id)?.done ?? 0),
    }));
    let addableTeams: { key: string; name: string }[] = [];
    if (a.canEdit) {
      const roles = await this.access.roleMap(actor);
      const candidates = [...roles].filter(([tid, role]) => roleAllows(role, "edit") && !a.teamIds.includes(tid)).map(([tid]) => tid);
      if (candidates.length) addableTeams = (await this.repo.teamsByIds(candidates)).map(({ key, name }) => ({ key, name })).sort((x, y) => x.key.localeCompare(y.key));
    }
    return { ...summary, canAdmin: a.canAdmin, repositories: await this.targets.ofProject(id), milestones, teams: teamViews, others, addableTeams };
  }

  // ───────── writing ─────────

  private async leadMember(actor: Actor, v: unknown): Promise<string | null | undefined> {
    if (v === undefined) return undefined;
    if (v === null || v === "") return null;
    if (!isUuid(v)) return bad("leadUser", "leadUser must be a person's id");
    const role = await this.access.workspaceRoleOf(actor.workspaceId, v);
    if (!role || role === "guest") return bad("leadUser", "The lead must be a member of the workspace (not a guest)");
    return v;
  }

  /** The project as it is now under a row lock; a version the caller read that is stale is a 409 with the project as it is. */
  private async lockProject(id: string, expected?: unknown) {
    const row = await this.repo.lockProject(id);
    if (typeof expected === "number" && row && expected !== row.version) throw new ServiceError("conflict", `The project was changed (version ${row.version}, you had ${expected}). Re-read and retry.`, { current: row });
    return row!;
  }

  async createProject(actor: Actor, input: ProjectInput, now = new Date()): Promise<ProjectDetail> {
    humanOnly(actor);
    await this.notGuest(actor);
    const name = text(input.name, "name", 120, true)!;
    const description = text(input.description, "description", 20_000) ?? "";
    const status = oneOf(input.status, schema.PROJECT_STATUSES, "status") ?? "planned";
    const priority = oneOf(input.priority, schema.PRIORITIES, "priority") ?? "none";
    const startDate = day(input.startDate, "startDate") ?? null;
    const targetDate = day(input.targetDate, "targetDate") ?? null;
    if (startDate && targetDate && targetDate < startDate) bad("targetDate", "The target date is before the start date");
    const healthOverride = oneOf(input.healthOverride, schema.PROJECT_HEALTH, "healthOverride") ?? null;
    if (typeof input.leadTeam !== "string" || !input.leadTeam) bad("leadTeam", "Choose the lead team");
    const lead = await this.access.require(actor, input.leadTeam as string, "edit");
    const others = Array.isArray(input.teams) ? input.teams : input.teams === undefined ? [] : bad("teams", "teams must be a list of team keys");
    const extra: (typeof lead)[] = [];
    for (const k of others as unknown[]) {
      if (typeof k !== "string") bad("teams", "teams must be a list of team keys");
      const t = await this.access.require(actor, k as string, "edit");
      if (t.id !== lead.id && !extra.some((x) => x.id === t.id)) extra.push(t);
    }
    const leadUser = (await this.leadMember(actor, input.leadUser)) ?? (actor.kind === "human" ? actor.id : null);
    const created = await this.db.transaction(async () => {
      const p = await this.repo.insertProject({ workspaceId: actor.workspaceId, name, description, status, priority, startDate, targetDate, healthOverride, leadUserId: leadUser, leadTeamId: lead.id });
      await this.repo.insertTeams([lead, ...extra].map((t) => ({ projectId: p.id, teamId: t.id, workspaceId: actor.workspaceId })));
      await this.workspaceEvent(actor, { type: "project.created", entityId: p.id, summary: `created project "${p.name}"`, data: { lead: lead.key, teams: [lead, ...extra].map((t) => t.key) } });
      await this.teamEvents(actor, [lead, ...extra].map((t) => t.id), { type: "project.created", entityId: p.id, summary: `took part in new project "${p.name}"`, data: { name: p.name } });
      return p;
    });
    return this.getProject(actor, created.id, now);
  }

  async updateProject(actor: Actor, id: string, patch: ProjectInput, now = new Date()): Promise<ProjectDetail> {
    const wantsLead = patch.leadUser !== undefined || patch.leadTeam !== undefined;
    await this.openProject(actor, id, wantsLead ? "admin" : "edit");
    const name = text(patch.name, "name", 120, patch.name !== undefined);
    const description = text(patch.description, "description", 20_000);
    const status = oneOf(patch.status, schema.PROJECT_STATUSES, "status");
    const priority = oneOf(patch.priority, schema.PRIORITIES, "priority");
    const startDate = day(patch.startDate, "startDate");
    const targetDate = day(patch.targetDate, "targetDate");
    const healthOverride = patch.healthOverride === null ? null : oneOf(patch.healthOverride, schema.PROJECT_HEALTH, "healthOverride");
    const leadUser = await this.leadMember(actor, patch.leadUser);
    await this.db.transaction(async () => {
      const cur = await this.lockProject(id, patch.version);
      const set: Partial<typeof schema.projects.$inferInsert> = {};
      if (name !== undefined && name !== cur.name) set.name = name;
      if (description !== undefined && description !== cur.description) set.description = description;
      if (status !== undefined && status !== cur.status) set.status = status;
      if (priority !== undefined && priority !== cur.priority) set.priority = priority;
      if (startDate !== undefined && startDate !== cur.startDate) set.startDate = startDate;
      if (targetDate !== undefined && targetDate !== cur.targetDate) set.targetDate = targetDate;
      if (healthOverride !== undefined && healthOverride !== cur.healthOverride) set.healthOverride = healthOverride;
      if (leadUser !== undefined && leadUser !== cur.leadUserId) set.leadUserId = leadUser;
      if (patch.leadTeam !== undefined) {
        if (typeof patch.leadTeam !== "string") bad("leadTeam", "leadTeam must be a team key");
        const t = await this.repo.teamByKey(actor.workspaceId, patch.leadTeam as string);
        const takes = t ? await this.repo.takesPart(id, t.id) : false;
        if (!t || !takes) bad("leadTeam", "The lead team must be one of the teams taking part");
        if (t!.id !== cur.leadTeamId) set.leadTeamId = t!.id;
      }
      const sd = set.startDate === undefined ? cur.startDate : set.startDate;
      const td = set.targetDate === undefined ? cur.targetDate : set.targetDate;
      if (sd && td && td < sd) bad("targetDate", "The target date is before the start date");
      if (patch.repositories !== undefined) {
        const was = JSON.stringify(await this.targets.ofProject(id));
        await this.targets.setProject(cur, targetInputs(patch.repositories, "repositories"));
        if (was !== JSON.stringify(await this.targets.ofProject(id))) await this.workspaceEvent(actor, { type: "project.updated", entityId: id, summary: `updated project "${cur.name}": repositories`, data: { changed: ["repositories"] } });
      }
      if (!Object.keys(set).length) return;
      const u = await this.repo.updateProject(id, { ...set, version: cur.version + 1, updatedAt: new Date() });
      const changed = Object.keys(set);
      await this.workspaceEvent(actor, { type: "project.updated", entityId: id, summary: `updated project "${u.name}": ${changed.join(", ")}`, data: { changed, from: Object.fromEntries(changed.map((k) => [k, (cur as Record<string, unknown>)[k]])), to: Object.fromEntries(changed.map((k) => [k, (u as Record<string, unknown>)[k]])) } });
      if (set.status || set.targetDate !== undefined) {
        await this.teamEvents(actor, await this.repo.teamIdsOf(id), { type: "project.status_changed", entityId: id, summary: `project "${u.name}" ${set.status ? `is now ${u.status}` : "has a new target date"}`, data: { name: u.name, status: u.status, targetDate: u.targetDate } });
      }
    });
    return this.getProject(actor, id, now);
  }

  /** Delete a project (soft). Its issues stay on their boards, in no project and no milestone. */
  async deleteProject(actor: Actor, id: string) {
    await this.openProject(actor, id, "admin");
    return this.db.transaction(async () => {
      const cur = await this.lockProject(id);
      const released = await this.repo.releaseIssues(id);
      await this.repo.updateProject(id, { deletedAt: new Date(), version: cur.version + 1, updatedAt: new Date() });
      const ids = await this.repo.teamIdsOf(id);
      await this.workspaceEvent(actor, { type: "project.deleted", entityId: id, summary: `deleted project "${cur.name}"${released.length ? ` (${released.length} issue${released.length === 1 ? "" : "s"} left it)` : ""}`, data: { name: cur.name, released: released.length } });
      await this.teamEvents(actor, ids, { type: "project.deleted", entityId: id, summary: `project "${cur.name}" was deleted`, data: { name: cur.name } });
      return { ok: true, released: released.length };
    });
  }

  // ───────── teams ─────────

  /** Bring a team in. The person needs to be able to change the project and to edit the team they bring (nobody is pulled in). */
  async addProjectTeam(actor: Actor, id: string, teamKey: unknown) {
    await this.openProject(actor, id, "edit");
    if (typeof teamKey !== "string" || !teamKey) bad("team", "Choose a team");
    const team = await this.access.require(actor, teamKey as string, "edit");
    await this.db.transaction(async () => {
      const cur = await this.lockProject(id);
      if (await this.repo.takesPart(id, team.id)) throw new ServiceError("conflict", `${team.name} already takes part`);
      await this.repo.insertTeams([{ projectId: id, teamId: team.id, workspaceId: actor.workspaceId }]);
      await this.repo.updateProject(id, { version: cur.version + 1, updatedAt: new Date() });
      await this.workspaceEvent(actor, { type: "project.team_added", entityId: id, summary: `${team.key} joined project "${cur.name}"`, data: { team: team.key } });
      await this.teamEvents(actor, [team.id], { type: "project.team_added", entityId: id, summary: `joined project "${cur.name}"`, data: { name: cur.name } });
    });
    return this.getProject(actor, id);
  }

  /**
   * Take a team out. The project's editors can, and so can an admin of that team (a team may leave). The lead team cannot go until
   * another is made lead. A team with issues in the project is refused with their number, unless `releaseIssues` says they
   * leave the project with it.
   */
  async removeProjectTeam(actor: Actor, id: string, teamKey: string, o: { releaseIssues?: boolean } = {}) {
    const a = await this.openProject(actor, id, "read");
    const team = await this.repo.teamByKey(actor.workspaceId, teamKey);
    if (!team || !a.teamIds.includes(team.id)) throw new ServiceError("not_found", `Team ${teamKey} does not take part in this project`);
    const roles = await this.access.roleMap(actor);
    const mayLeave = roles.get(team.id) === "admin";
    if (!a.canEdit && !mayLeave) throw new ServiceError("forbidden", "Only the project lead, an editor of the lead team, or an admin of that team can take it out");
    if (team.id === a.project.leadTeamId) throw new ServiceError("conflict", "That is the lead team. Make another team the lead first.");
    return this.db.transaction(async () => {
      const cur = await this.lockProject(id);
      const n = await this.repo.countTeamIssues(id, team.id);
      if (n > 0 && !o.releaseIssues) throw new ServiceError("conflict", `${team.name} has ${n} issue${n === 1 ? "" : "s"} in this project. Release them with the team, or move them out first.`, { issues: n });
      if (n > 0) await this.repo.releaseIssues(id, team.id);
      await this.repo.deleteTeam(id, team.id);
      await this.repo.updateProject(id, { version: cur.version + 1, updatedAt: new Date() });
      await this.workspaceEvent(actor, { type: "project.team_removed", entityId: id, summary: `${team.key} left project "${cur.name}"${n ? ` (${n} issue${n === 1 ? "" : "s"} left with it)` : ""}`, data: { team: team.key, released: n } });
      await this.teamEvents(actor, [team.id], { type: "project.team_removed", entityId: id, summary: `left project "${cur.name}"`, data: { name: cur.name, released: n } });
      return { ok: true, released: n };
    });
  }

  // ───────── milestones ─────────

  async createMilestone(actor: Actor, id: string, input: MilestoneInput) {
    await this.openProject(actor, id, "edit");
    const name = text(input.name, "name", 120, true)!;
    const description = text(input.description, "description", 5_000) ?? "";
    const targetDate = day(input.targetDate, "targetDate") ?? null;
    await this.db.transaction(async () => {
      const cur = await this.lockProject(id);
      const position = (await this.repo.maxMilestonePosition(id)) + 1000;
      const m = await this.repo.insertMilestone({ projectId: id, workspaceId: actor.workspaceId, name, description, targetDate, position });
      await this.repo.touchProject(id);
      await this.workspaceEvent(actor, { type: "project.milestone_changed", entityId: id, summary: `added milestone "${m.name}" to project "${cur.name}"`, data: { milestone: m.id, change: "added", name: m.name } });
      await this.teamEvents(actor, await this.repo.teamIdsOf(id), { type: "project.milestone_changed", entityId: id, summary: `project "${cur.name}" has a new milestone "${m.name}"`, data: { milestone: m.id, change: "added", name: m.name } });
    });
    return this.getProject(actor, id);
  }

  async updateMilestone(actor: Actor, id: string, milestoneId: string, patch: MilestoneInput) {
    await this.openProject(actor, id, "edit");
    const name = text(patch.name, "name", 120, patch.name !== undefined);
    const description = text(patch.description, "description", 5_000);
    const targetDate = day(patch.targetDate, "targetDate");
    if (patch.index !== undefined && (typeof patch.index !== "number" || !Number.isSafeInteger(patch.index) || patch.index < 0)) bad("index", "index must be a position from 0");
    await this.db.transaction(async () => {
      const cur = await this.lockProject(id);
      const m = isUuid(milestoneId) ? await this.repo.findMilestone(id, milestoneId) : undefined;
      if (!m) throw new ServiceError("not_found", "Milestone not found");
      const set: Partial<typeof schema.projectMilestones.$inferInsert> = {};
      if (name !== undefined && name !== m.name) set.name = name;
      if (description !== undefined && description !== m.description) set.description = description;
      if (targetDate !== undefined && targetDate !== m.targetDate) set.targetDate = targetDate;
      if (typeof patch.index === "number") {
        const others = (await this.repo.milestonePositions(id)).filter((s) => s.id !== m.id);
        const i = Math.min(patch.index, others.length);
        const position = positionBetween(others[i - 1]?.position, others[i]?.position);
        if (position !== m.position) set.position = position;
      }
      if (!Object.keys(set).length) return;
      await this.repo.updateMilestone(m.id, set);
      await this.repo.touchProject(id);
      const changed = Object.keys(set);
      await this.workspaceEvent(actor, { type: "project.milestone_changed", entityId: id, summary: `changed milestone "${m.name}" of project "${cur.name}": ${changed.join(", ")}`, data: { milestone: m.id, change: "updated", changed } });
      await this.teamEvents(actor, await this.repo.teamIdsOf(id), { type: "project.milestone_changed", entityId: id, summary: `milestone "${m.name}" of project "${cur.name}" changed: ${changed.join(", ")}`, data: { milestone: m.id, change: "updated", changed } });
    });
    return this.getProject(actor, id);
  }

  async deleteMilestone(actor: Actor, id: string, milestoneId: string) {
    await this.openProject(actor, id, "edit");
    await this.db.transaction(async () => {
      const cur = await this.lockProject(id);
      const m = isUuid(milestoneId) ? await this.repo.findMilestone(id, milestoneId) : undefined;
      if (!m) throw new ServiceError("not_found", "Milestone not found");
      await this.repo.deleteMilestone(m.id);
      await this.repo.touchProject(id);
      await this.workspaceEvent(actor, { type: "project.milestone_changed", entityId: id, summary: `removed milestone "${m.name}" from project "${cur.name}"`, data: { milestone: m.id, change: "removed", name: m.name } });
      await this.teamEvents(actor, await this.repo.teamIdsOf(id), { type: "project.milestone_changed", entityId: id, summary: `project "${cur.name}" lost its milestone "${m.name}"`, data: { milestone: m.id, change: "removed", name: m.name } });
    });
    return this.getProject(actor, id);
  }

  // ───────── an issue's project ─────────

  /**
   * What an issue's `project` and `milestone` mean for its team. The project must be live in the workspace and the team must take
   * part (the database refuses the rest); a milestone must be the project's. Changing the project drops the milestone unless one of
   * the new project is named, and a milestone alone keeps the project the issue is in.
   */
  async resolveIssueProject(
    team: { id: string; name: string; workspaceId: string },
    current: IssueProjectChoice,
    want: { project?: string | null; milestone?: string | null },
  ): Promise<IssueProjectChoice> {
    let projectId = want.project === undefined ? current.projectId : want.project;
    const milestoneId = want.milestone === undefined ? (projectId === current.projectId ? current.milestoneId : null) : want.milestone;
    if (projectId !== null) {
      if (!isUuid(projectId)) bad("projectId", "projectId must be a project id, or null for none");
      const p = await this.repo.findLive(team.workspaceId, projectId);
      if (!p) bad("projectId", "That project does not exist");
      if (!(await this.repo.takesPart(projectId, team.id))) bad("projectId", `${team.name} does not take part in "${p!.name}". Ask the project's lead to bring the team in first.`);
    } else {
      if (milestoneId !== null) bad("milestoneId", "A milestone needs a project");
      projectId = null;
    }
    if (milestoneId !== null) {
      if (!isUuid(milestoneId)) bad("milestoneId", "milestoneId must be a milestone id, or null for none");
      if (!(await this.repo.findMilestone(projectId!, milestoneId))) bad("milestoneId", "That milestone is not in this issue's project");
    }
    return { projectId, milestoneId };
  }

  /** The projects a team takes part in, with their milestones, for the board's chips and the issue's Project field. */
  async projectsOfTeam(teamId: string): Promise<TeamProjectOption[]> {
    const rows = await this.repo.projectsOfTeam(teamId);
    if (!rows.length) return [];
    const ms = await this.repo.milestonesFor(rows.map((r) => r.id));
    return rows.map((r) => ({ ...r, milestones: ms.filter((m) => m.projectId === r.id).map(({ id, name }) => ({ id, name })) }));
  }
}
