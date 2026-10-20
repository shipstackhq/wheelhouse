import type { Actor } from "./access";
import * as pr from "./projects";

/**
 * What the web app's Projects pages read and write (WH-118), as functions of the signed-in person. Every answer is already limited to
 * what that person may see: teams they are not on appear only as totals, and a guest sees no projects.
 */

type Body = Record<string, unknown>;

export const listProjectsAs = (actor: Actor) => pr.listProjects(actor);
export const getProjectAs = (actor: Actor, id: string) => pr.getProject(actor, id);
export const createProjectAs = (actor: Actor, b: Body) => pr.createProject(actor, b);
export const updateProjectAs = (actor: Actor, id: string, b: Body) => pr.updateProject(actor, id, b);
export const deleteProjectAs = (actor: Actor, id: string) => pr.deleteProject(actor, id);
export const addProjectTeamAs = (actor: Actor, id: string, b: Body) => pr.addProjectTeam(actor, id, b.team);
export const removeProjectTeamAs = (actor: Actor, id: string, teamKey: string, releaseTickets: boolean) => pr.removeProjectTeam(actor, id, teamKey, { releaseTickets });
export const createMilestoneAs = (actor: Actor, id: string, b: Body) => pr.createMilestone(actor, id, b);
export const updateMilestoneAs = (actor: Actor, id: string, milestoneId: string, b: Body) => pr.updateMilestone(actor, id, milestoneId, b);
export const deleteMilestoneAs = (actor: Actor, id: string, milestoneId: string) => pr.deleteMilestone(actor, id, milestoneId);
