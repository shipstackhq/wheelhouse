import type { Actor } from "../../common/actor";
import type { Need } from "../../common/roles";
import type { Database } from "../../platform/database/database";
import type { Q } from "../../platform/database/transaction";
import type { StatusesService } from "./statuses.service";
import type { TeamAccessService } from "./team-access.service";
import type { TeamLifecycleService } from "./team-lifecycle.service";
import type { TeamMembersService } from "./team-members.service";
import type { TeamsService } from "./teams.service";

/**
 * Temporary. Code that is not converted yet (other modules, the MCP tools, tests) still calls plain functions; these are those
 * functions, each one line forwarding to the live service. `TeamsModule.onModuleInit` points them at the services Nest built, so
 * nothing works before the application has booted (tests call `testApp()`). A function that takes a `q` runs on it through
 * `Database.within`, so a caller's own transaction stays the one the service writes on. Delete this file when the last caller
 * moves to the services (the MCP redesign moves the tools).
 */
type Live = { db: Database; access: TeamAccessService; teams: TeamsService; lifecycle: TeamLifecycleService; members: TeamMembersService; statuses: StatusesService };
let live: Live | undefined;

export function bindTeamsLegacy(services: Live) {
  live = services;
}
const s = (): Live => live ?? (() => { throw new Error("The teams module is not booted: start the Nest application (tests: await testApp()) before calling the legacy functions"); })();
const on = <T>(q: Q | undefined, fn: () => Promise<T>): Promise<T> => (q ? s().db.within(q, fn) : fn());

// access
export const requireTeam = (actor: Actor, ref: string, need: Need = "read", q?: Q) => on(q, () => s().access.require(actor, ref, need));
export const roleOnTeam = (q: Q, actor: Actor, teamId: string) => on(q, () => s().access.roleOn(actor, teamId));
export const visibleTeamIds = (q: Q, actor: Actor) => on(q, () => s().access.visibleTeamIds(actor));
export const teamRoleMap = (q: Q, actor: Actor) => on(q, () => s().access.roleMap(actor));
export const workspaceRoleOf = (q: Q, workspaceId: string, userId: string) => on(q, () => s().access.workspaceRoleOf(workspaceId, userId));
export const audit = (q: Q, actor: Actor, e: Parameters<TeamAccessService["audit"]>[1]) => on(q, () => s().access.audit(actor, e));

// teams
export const listTeams = (...a: Parameters<TeamsService["list"]>) => s().teams.list(...a);
export const createTeam = (...a: Parameters<TeamsService["create"]>) => s().teams.create(...a);
export const updateTeam = (...a: Parameters<TeamsService["update"]>) => s().teams.update(...a);
export const deleteTeam = (...a: Parameters<TeamsService["delete"]>) => s().teams.delete(...a);

// lifecycle
export const retireTeam = (...a: Parameters<TeamLifecycleService["retire"]>) => s().lifecycle.retire(...a);
export const restoreTeam = (...a: Parameters<TeamLifecycleService["restore"]>) => s().lifecycle.restore(...a);
export const setTeamParent = (...a: Parameters<TeamLifecycleService["setParent"]>) => s().lifecycle.setParent(...a);
export const getTeamSettings = (...a: Parameters<TeamLifecycleService["settings"]>) => s().lifecycle.settings(...a);
export const parentCandidates = (...a: Parameters<TeamLifecycleService["parentCandidates"]>) => s().lifecycle.parentCandidates(...a);

// members
export const listTeamsWithRole = (...a: Parameters<TeamMembersService["listWithRole"]>) => s().members.listWithRole(...a);
export const setTeamOrder = (...a: Parameters<TeamMembersService["setOrder"]>) => s().members.setOrder(...a);
export const listTeamMembers = (...a: Parameters<TeamMembersService["list"]>) => s().members.list(...a);
export const listAddableMembers = (...a: Parameters<TeamMembersService["listAddable"]>) => s().members.listAddable(...a);
export const addTeamMember = (...a: Parameters<TeamMembersService["add"]>) => s().members.add(...a);
export const setTeamMemberRole = (...a: Parameters<TeamMembersService["setRole"]>) => s().members.setRole(...a);
export const removeTeamMember = (...a: Parameters<TeamMembersService["remove"]>) => s().members.remove(...a);
export const listWorkspaceTeams = (...a: Parameters<TeamMembersService["listWorkspaceTeams"]>) => s().members.listWorkspaceTeams(...a);
export const joinTeamAsWorkspaceAdmin = (...a: Parameters<TeamMembersService["joinAsWorkspaceAdmin"]>) => s().members.joinAsWorkspaceAdmin(...a);
export const listAudit = (...a: Parameters<TeamMembersService["listAudit"]>) => s().members.listAudit(...a);

// statuses
export const listStatuses = (...a: Parameters<StatusesService["list"]>) => s().statuses.list(...a);
export const createStatus = (...a: Parameters<StatusesService["create"]>) => s().statuses.create(...a);
export const updateStatus = (...a: Parameters<StatusesService["update"]>) => s().statuses.update(...a);
export const reorderStatuses = (...a: Parameters<StatusesService["reorder"]>) => s().statuses.reorder(...a);
export const deleteStatus = (...a: Parameters<StatusesService["delete"]>) => s().statuses.delete(...a);
