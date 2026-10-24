import { Injectable } from "@nestjs/common";
import { logIn, signUp, signupAllowed } from "./accounts";
import { endSession, listWorkspaces, switchWorkspace } from "./auth-core";
import { acceptInviteAs, acceptInviteAsMemberAs, agentsPage, changePasswordAs, createInviteAs, createKeyAs, peekInviteAs, peekInviteAsMemberAs, pendingInvites, removeMemberAs, revokeInviteAs, revokeKeyAs, setKeyDocsWriteAs, setKeyTeamsAs, updateMemberAs, workspaceOverview } from "./workspace-app";
import { listWorkspaces as adminListWorkspaces, getWorkspaceDetail, restoreWorkspace, suspendWorkspace } from "./workspaces-admin";

/**
 * What the auth area (accounts, sessions, workspaces, members, invites and API keys) can do, as the one door to it: the
 * controllers (and, later, other modules through this module's index.ts) call this, never the functions in this folder
 * directly. For now each method hands over to the function of the same name with the same arguments and answer; folding the
 * functions into service methods can wait (docs/nest-architecture.md).
 */
@Injectable()
export class AuthService {
  acceptInviteAs(...a: Parameters<typeof acceptInviteAs>) {
    return acceptInviteAs(...a);
  }
  acceptInviteAsMemberAs(...a: Parameters<typeof acceptInviteAsMemberAs>) {
    return acceptInviteAsMemberAs(...a);
  }
  adminListWorkspaces(...a: Parameters<typeof adminListWorkspaces>) {
    return adminListWorkspaces(...a);
  }
  agentsPage(...a: Parameters<typeof agentsPage>) {
    return agentsPage(...a);
  }
  changePasswordAs(...a: Parameters<typeof changePasswordAs>) {
    return changePasswordAs(...a);
  }
  createInviteAs(...a: Parameters<typeof createInviteAs>) {
    return createInviteAs(...a);
  }
  createKeyAs(...a: Parameters<typeof createKeyAs>) {
    return createKeyAs(...a);
  }
  endSession(...a: Parameters<typeof endSession>) {
    return endSession(...a);
  }
  getWorkspaceDetail(...a: Parameters<typeof getWorkspaceDetail>) {
    return getWorkspaceDetail(...a);
  }
  listWorkspaces(...a: Parameters<typeof listWorkspaces>) {
    return listWorkspaces(...a);
  }
  logIn(...a: Parameters<typeof logIn>) {
    return logIn(...a);
  }
  peekInviteAs(...a: Parameters<typeof peekInviteAs>) {
    return peekInviteAs(...a);
  }
  peekInviteAsMemberAs(...a: Parameters<typeof peekInviteAsMemberAs>) {
    return peekInviteAsMemberAs(...a);
  }
  pendingInvites(...a: Parameters<typeof pendingInvites>) {
    return pendingInvites(...a);
  }
  removeMemberAs(...a: Parameters<typeof removeMemberAs>) {
    return removeMemberAs(...a);
  }
  restoreWorkspace(...a: Parameters<typeof restoreWorkspace>) {
    return restoreWorkspace(...a);
  }
  revokeInviteAs(...a: Parameters<typeof revokeInviteAs>) {
    return revokeInviteAs(...a);
  }
  revokeKeyAs(...a: Parameters<typeof revokeKeyAs>) {
    return revokeKeyAs(...a);
  }
  setKeyDocsWriteAs(...a: Parameters<typeof setKeyDocsWriteAs>) {
    return setKeyDocsWriteAs(...a);
  }
  setKeyTeamsAs(...a: Parameters<typeof setKeyTeamsAs>) {
    return setKeyTeamsAs(...a);
  }
  signUp(...a: Parameters<typeof signUp>) {
    return signUp(...a);
  }
  signupAllowed(...a: Parameters<typeof signupAllowed>) {
    return signupAllowed(...a);
  }
  suspendWorkspace(...a: Parameters<typeof suspendWorkspace>) {
    return suspendWorkspace(...a);
  }
  switchWorkspace(...a: Parameters<typeof switchWorkspace>) {
    return switchWorkspace(...a);
  }
  updateMemberAs(...a: Parameters<typeof updateMemberAs>) {
    return updateMemberAs(...a);
  }
  workspaceOverview(...a: Parameters<typeof workspaceOverview>) {
    return workspaceOverview(...a);
  }
}
