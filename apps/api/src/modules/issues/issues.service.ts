import { Injectable } from "@nestjs/common";
import { addComment, deleteIssue } from "./issues";
import { boardView, createIssueAs, issueDetail, moveIssueAs, updateIssueAs } from "./board-app";
import { createCycleAs, deleteCycleAs, getCycleAs, listCyclesAs, updateCycleAs } from "./cycles-app";
import { createInitiativeAs, deleteInitiativeAs, getInitiativeAs, linkProjectAs, listInitiativesAs, unlinkProjectAs, updateInitiativeAs } from "./initiatives-app";
import { linkIssueNode } from "./issue-nodes";
import { addProjectTeamAs, createMilestoneAs, createProjectAs, deleteMilestoneAs, deleteProjectAs, getProjectAs, listProjectsAs, removeProjectTeamAs, updateMilestoneAs, updateProjectAs } from "./projects-app";

/**
 * What the issues area (issues, cycles, projects, initiatives) can do, as the one door to it: the controllers (and, later, other
 * modules through this module's index.ts) call this, never the functions in this folder directly. For now each method hands
 * over to the function of the same name with the same arguments and answer; folding the functions into service methods can
 * wait (docs/nest-architecture.md).
 */
@Injectable()
export class IssuesService {
  addComment(...a: Parameters<typeof addComment>) {
    return addComment(...a);
  }
  addProjectTeamAs(...a: Parameters<typeof addProjectTeamAs>) {
    return addProjectTeamAs(...a);
  }
  boardView(...a: Parameters<typeof boardView>) {
    return boardView(...a);
  }
  createCycleAs(...a: Parameters<typeof createCycleAs>) {
    return createCycleAs(...a);
  }
  createInitiativeAs(...a: Parameters<typeof createInitiativeAs>) {
    return createInitiativeAs(...a);
  }
  createIssueAs(...a: Parameters<typeof createIssueAs>) {
    return createIssueAs(...a);
  }
  createMilestoneAs(...a: Parameters<typeof createMilestoneAs>) {
    return createMilestoneAs(...a);
  }
  createProjectAs(...a: Parameters<typeof createProjectAs>) {
    return createProjectAs(...a);
  }
  deleteCycleAs(...a: Parameters<typeof deleteCycleAs>) {
    return deleteCycleAs(...a);
  }
  deleteInitiativeAs(...a: Parameters<typeof deleteInitiativeAs>) {
    return deleteInitiativeAs(...a);
  }
  deleteIssue(...a: Parameters<typeof deleteIssue>) {
    return deleteIssue(...a);
  }
  deleteMilestoneAs(...a: Parameters<typeof deleteMilestoneAs>) {
    return deleteMilestoneAs(...a);
  }
  deleteProjectAs(...a: Parameters<typeof deleteProjectAs>) {
    return deleteProjectAs(...a);
  }
  getCycleAs(...a: Parameters<typeof getCycleAs>) {
    return getCycleAs(...a);
  }
  getInitiativeAs(...a: Parameters<typeof getInitiativeAs>) {
    return getInitiativeAs(...a);
  }
  getProjectAs(...a: Parameters<typeof getProjectAs>) {
    return getProjectAs(...a);
  }
  issueDetail(...a: Parameters<typeof issueDetail>) {
    return issueDetail(...a);
  }
  linkIssueNode(...a: Parameters<typeof linkIssueNode>) {
    return linkIssueNode(...a);
  }
  linkProjectAs(...a: Parameters<typeof linkProjectAs>) {
    return linkProjectAs(...a);
  }
  listCyclesAs(...a: Parameters<typeof listCyclesAs>) {
    return listCyclesAs(...a);
  }
  listInitiativesAs(...a: Parameters<typeof listInitiativesAs>) {
    return listInitiativesAs(...a);
  }
  listProjectsAs(...a: Parameters<typeof listProjectsAs>) {
    return listProjectsAs(...a);
  }
  moveIssueAs(...a: Parameters<typeof moveIssueAs>) {
    return moveIssueAs(...a);
  }
  removeProjectTeamAs(...a: Parameters<typeof removeProjectTeamAs>) {
    return removeProjectTeamAs(...a);
  }
  unlinkProjectAs(...a: Parameters<typeof unlinkProjectAs>) {
    return unlinkProjectAs(...a);
  }
  updateCycleAs(...a: Parameters<typeof updateCycleAs>) {
    return updateCycleAs(...a);
  }
  updateInitiativeAs(...a: Parameters<typeof updateInitiativeAs>) {
    return updateInitiativeAs(...a);
  }
  updateIssueAs(...a: Parameters<typeof updateIssueAs>) {
    return updateIssueAs(...a);
  }
  updateMilestoneAs(...a: Parameters<typeof updateMilestoneAs>) {
    return updateMilestoneAs(...a);
  }
  updateProjectAs(...a: Parameters<typeof updateProjectAs>) {
    return updateProjectAs(...a);
  }
}
