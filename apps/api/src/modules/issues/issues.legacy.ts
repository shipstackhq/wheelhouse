import type { Database } from "../../platform/database/database";
import type { Q } from "../../platform/database/transaction";
import type { CyclesService } from "./cycles/cycles.service";
import type { InitiativesService } from "./initiatives/initiatives.service";
import type { IssuesService } from "./issues.service";
import type { ProjectsService } from "./projects/projects.service";
import { issueDetailView } from "./issues.presenter";

/**
 * Temporary. Code that is not converted yet (the MCP tools through lib/service.ts, the map and daemon modules, tests) still calls plain
 * functions; these are those functions, each one line forwarding to the live service. `IssuesModule.onModuleInit` points them at the
 * services Nest built, so nothing works before the application has booted (tests call `testApp()`). A function that takes a `q` runs on
 * it through `Database.within`, so a caller's own transaction stays the one the service uses. Delete this file when the last caller
 * moves to the services (the MCP redesign moves the tools).
 */
type Live = { db: Database; issues: IssuesService; cycles: CyclesService; projects: ProjectsService; initiatives: InitiativesService };
let live: Live | undefined;

export function bindIssuesLegacy(services: Live) {
  live = services;
}
const s = (): Live => live ?? (() => { throw new Error("The issues module is not booted: start the Nest application (tests: await testApp()) before calling the legacy functions"); })();

/** Runs `fn` in one transaction: the services it calls join it, so a batch applies whole or not at all. */
export const transaction = <T>(fn: () => Promise<T>) => s().db.transaction(fn);

// issues
export const getBoard = (...a: Parameters<IssuesService["getBoard"]>) => s().issues.getBoard(...a);
export const getIssue = (...a: Parameters<IssuesService["getIssue"]>) => s().issues.getIssue(...a);
export const issueDetail = async (...a: Parameters<IssuesService["getIssue"]>) => issueDetailView(await s().issues.getIssue(...a));
export const resolveIssue = (actor: Parameters<IssuesService["resolveIssue"]>[0], ref: string, q?: Q, need?: Parameters<IssuesService["resolveIssue"]>[2]) =>
  q ? s().db.within(q, () => s().issues.resolveIssue(actor, ref, need)) : s().issues.resolveIssue(actor, ref, need);
export const createIssue = (...a: Parameters<IssuesService["createIssue"]>) => s().issues.createIssue(...a);
export const updateIssue = (...a: Parameters<IssuesService["updateIssue"]>) => s().issues.updateIssue(...a);
export const moveIssue = (...a: Parameters<IssuesService["moveIssue"]>) => s().issues.moveIssue(...a);
export const deleteIssue = (...a: Parameters<IssuesService["deleteIssue"]>) => s().issues.deleteIssue(...a);
export const claimIssue = (...a: Parameters<IssuesService["claimIssue"]>) => s().issues.claimIssue(...a);
export const addComment = (...a: Parameters<IssuesService["addComment"]>) => s().issues.addComment(...a);
export const linkIssueNode = (...a: Parameters<IssuesService["linkIssueNode"]>) => s().issues.linkIssueNode(...a);

// cycles
export const listCycles = (...a: Parameters<CyclesService["listCycles"]>) => s().cycles.listCycles(...a);
export const getCycle = (...a: Parameters<CyclesService["getCycle"]>) => s().cycles.getCycle(...a);
export const createCycle = (...a: Parameters<CyclesService["createCycle"]>) => s().cycles.createCycle(...a);
export const updateCycle = (...a: Parameters<CyclesService["updateCycle"]>) => s().cycles.updateCycle(...a);
export const deleteCycle = (...a: Parameters<CyclesService["deleteCycle"]>) => s().cycles.deleteCycle(...a);
export const rolloverCycles = (...a: Parameters<CyclesService["rolloverCycles"]>) => s().cycles.rolloverCycles(...a);

// projects and milestones
export const listProjects = (...a: Parameters<ProjectsService["listProjects"]>) => s().projects.listProjects(...a);
export const getProject = (...a: Parameters<ProjectsService["getProject"]>) => s().projects.getProject(...a);
export const createProject = (...a: Parameters<ProjectsService["createProject"]>) => s().projects.createProject(...a);
export const updateProject = (...a: Parameters<ProjectsService["updateProject"]>) => s().projects.updateProject(...a);
export const deleteProject = (...a: Parameters<ProjectsService["deleteProject"]>) => s().projects.deleteProject(...a);
export const addProjectTeam = (...a: Parameters<ProjectsService["addProjectTeam"]>) => s().projects.addProjectTeam(...a);
export const removeProjectTeam = (...a: Parameters<ProjectsService["removeProjectTeam"]>) => s().projects.removeProjectTeam(...a);
export const createMilestone = (...a: Parameters<ProjectsService["createMilestone"]>) => s().projects.createMilestone(...a);
export const updateMilestone = (...a: Parameters<ProjectsService["updateMilestone"]>) => s().projects.updateMilestone(...a);
export const deleteMilestone = (...a: Parameters<ProjectsService["deleteMilestone"]>) => s().projects.deleteMilestone(...a);
export const projectsOfTeam = (...a: Parameters<ProjectsService["projectsOfTeam"]>) => s().projects.projectsOfTeam(...a);

// initiatives
export const listInitiatives = (...a: Parameters<InitiativesService["listInitiatives"]>) => s().initiatives.listInitiatives(...a);
export const getInitiative = (...a: Parameters<InitiativesService["getInitiative"]>) => s().initiatives.getInitiative(...a);
export const createInitiative = (...a: Parameters<InitiativesService["createInitiative"]>) => s().initiatives.createInitiative(...a);
export const updateInitiative = (...a: Parameters<InitiativesService["updateInitiative"]>) => s().initiatives.updateInitiative(...a);
export const deleteInitiative = (...a: Parameters<InitiativesService["deleteInitiative"]>) => s().initiatives.deleteInitiative(...a);
export const linkProject = (...a: Parameters<InitiativesService["linkProject"]>) => s().initiatives.linkProject(...a);
export const unlinkProject = (...a: Parameters<InitiativesService["unlinkProject"]>) => s().initiatives.unlinkProject(...a);

// the pure rules and types the tests read through the same names
export { deriveHealth, stateOf, type IssueInput } from "./issues.rules";
export type { CycleDetail, CycleSummary } from "./cycles/cycles.service";
export type { ProjectDetail, ProjectRow } from "./projects/projects.service";
