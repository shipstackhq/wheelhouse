import { Injectable } from "@nestjs/common";
import { createTeam, deleteTeam, removeSession, updateTeam } from "../../lib/service";
import { createStatus, deleteStatus, listStatuses, reorderStatuses, updateStatus } from "./statuses";
import { getTeamSettings, parentCandidates, restoreTeam, retireTeam, setTeamParent } from "./team-lifecycle";
import { addTeamMember, joinTeamAsWorkspaceAdmin, listAddableMembers, listAudit, listTeamMembers, listTeamsWithRole, listWorkspaceTeams, removeTeamMember, setTeamMemberRole, setTeamOrder } from "./team-members";

/**
 * What the teams area can do, as the one door to it: the controllers (and, later, other modules through this module's index.ts)
 * call this, never the functions in this folder directly. For now each method hands over to the function of the same name with
 * the same arguments and answer; folding the functions into service methods can wait (docs/nest-architecture.md).
 */
@Injectable()
export class TeamsService {
  addTeamMember(...a: Parameters<typeof addTeamMember>) {
    return addTeamMember(...a);
  }
  createStatus(...a: Parameters<typeof createStatus>) {
    return createStatus(...a);
  }
  createTeam(...a: Parameters<typeof createTeam>) {
    return createTeam(...a);
  }
  deleteStatus(...a: Parameters<typeof deleteStatus>) {
    return deleteStatus(...a);
  }
  deleteTeam(...a: Parameters<typeof deleteTeam>) {
    return deleteTeam(...a);
  }
  getTeamSettings(...a: Parameters<typeof getTeamSettings>) {
    return getTeamSettings(...a);
  }
  joinTeamAsWorkspaceAdmin(...a: Parameters<typeof joinTeamAsWorkspaceAdmin>) {
    return joinTeamAsWorkspaceAdmin(...a);
  }
  listAddableMembers(...a: Parameters<typeof listAddableMembers>) {
    return listAddableMembers(...a);
  }
  listAudit(...a: Parameters<typeof listAudit>) {
    return listAudit(...a);
  }
  listStatuses(...a: Parameters<typeof listStatuses>) {
    return listStatuses(...a);
  }
  listTeamMembers(...a: Parameters<typeof listTeamMembers>) {
    return listTeamMembers(...a);
  }
  listTeamsWithRole(...a: Parameters<typeof listTeamsWithRole>) {
    return listTeamsWithRole(...a);
  }
  listWorkspaceTeams(...a: Parameters<typeof listWorkspaceTeams>) {
    return listWorkspaceTeams(...a);
  }
  parentCandidates(...a: Parameters<typeof parentCandidates>) {
    return parentCandidates(...a);
  }
  removeSession(...a: Parameters<typeof removeSession>) {
    return removeSession(...a);
  }
  removeTeamMember(...a: Parameters<typeof removeTeamMember>) {
    return removeTeamMember(...a);
  }
  reorderStatuses(...a: Parameters<typeof reorderStatuses>) {
    return reorderStatuses(...a);
  }
  restoreTeam(...a: Parameters<typeof restoreTeam>) {
    return restoreTeam(...a);
  }
  retireTeam(...a: Parameters<typeof retireTeam>) {
    return retireTeam(...a);
  }
  setTeamMemberRole(...a: Parameters<typeof setTeamMemberRole>) {
    return setTeamMemberRole(...a);
  }
  setTeamOrder(...a: Parameters<typeof setTeamOrder>) {
    return setTeamOrder(...a);
  }
  setTeamParent(...a: Parameters<typeof setTeamParent>) {
    return setTeamParent(...a);
  }
  updateStatus(...a: Parameters<typeof updateStatus>) {
    return updateStatus(...a);
  }
  updateTeam(...a: Parameters<typeof updateTeam>) {
    return updateTeam(...a);
  }
}
