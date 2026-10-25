import type { Database } from "../../platform/database/database";
import type { Q } from "../../platform/database/transaction";
import type { InvitesService } from "./invites/invites.service";
import type { KeysService } from "./keys/keys.service";
import type { SessionsService } from "./sessions.service";
import type { WorkspacesService } from "./workspaces/workspaces.service";

/**
 * Temporary. Code that is not converted yet (the request guards and the stream, the other modules' tests, the module's own tests) still
 * calls plain functions; these are those functions, each one line forwarding to the live service. `AuthModule.onModuleInit` points them at
 * the services Nest built, so nothing works before the application has booted (tests call `testApp()`). A function that takes a `q` runs on
 * it through `Database.within`. Delete this file when the last caller moves to the services.
 */
type Live = { db: Database; sessions: SessionsService; keys: KeysService; invites: InvitesService; workspaces: WorkspacesService };
let live: Live | undefined;

export function bindAuthLegacy(services: Live) {
  live = services;
}
const s = (): Live => live ?? (() => { throw new Error("The auth module is not booted: start the Nest application (tests: await testApp()) before calling the legacy functions"); })();

// sessions and sign-in
export const humanFromSession = (...a: Parameters<SessionsService["humanFromSession"]>) => s().sessions.humanFromSession(...a);
export const actorFromCredentials = (...a: Parameters<SessionsService["actorFromCredentials"]>) => s().sessions.actorFromCredentials(...a);
export const userForSessionToken = (...a: Parameters<SessionsService["userForSessionToken"]>) => s().sessions.userForSessionToken(...a);
export const userWorkspaceSuspended = (...a: Parameters<SessionsService["userWorkspaceSuspended"]>) => s().sessions.userWorkspaceSuspended(...a);
export const currentMembership = (...a: Parameters<SessionsService["currentMembership"]>) => s().sessions.currentMembership(...a);
export const listWorkspaces = (...a: Parameters<SessionsService["listWorkspaces"]>) => s().sessions.listWorkspaces(...a);
export const switchWorkspace = (...a: Parameters<SessionsService["switchWorkspace"]>) => s().sessions.switchWorkspace(...a);
export const startSession = (...a: Parameters<SessionsService["startSession"]>) => s().sessions.startSession(...a);
export const endSession = (...a: Parameters<SessionsService["endSession"]>) => s().sessions.endSession(...a);
export const logIn = (...a: Parameters<SessionsService["logIn"]>) => s().sessions.logIn(...a);
export const signUp = (...a: Parameters<SessionsService["signUp"]>) => s().sessions.signUp(...a);
export const signupAllowed = (...a: Parameters<SessionsService["signupAllowed"]>) => s().sessions.signupAllowed(...a);
export const changePasswordAs = (...a: Parameters<SessionsService["changePasswordAs"]>) => s().sessions.changePasswordAs(...a);

// API keys
export const actorForKey = (...a: Parameters<KeysService["actorForKey"]>) => s().keys.actorForKey(...a);
export const scopeKeyToAllTeams = (q: Q, keyId: string, workspaceId: string) => s().db.within(q, () => s().keys.scopeKeyToAllTeams(keyId, workspaceId));
export const listKeys = (...a: Parameters<KeysService["listKeys"]>) => s().keys.listKeys(...a);
export const keysPage = (...a: Parameters<KeysService["keysPage"]>) => s().keys.keysPage(...a);
export const createKeyAs = (...a: Parameters<KeysService["createKeyAs"]>) => s().keys.createKeyAs(...a);
export const setKeyTeamsAs = (...a: Parameters<KeysService["setKeyTeamsAs"]>) => s().keys.setKeyTeamsAs(...a);
export const revokeKeyAs = (...a: Parameters<KeysService["revokeKeyAs"]>) => s().keys.revokeKeyAs(...a);
export const setKeyDocsWriteAs = (...a: Parameters<KeysService["setKeyDocsWriteAs"]>) => s().keys.setKeyDocsWriteAs(...a);
export const revokeApiKey = (...a: Parameters<KeysService["revokeApiKey"]>) => s().keys.revokeApiKey(...a);

// invites
export const seatInfo = (...a: Parameters<InvitesService["seatInfo"]>) => s().invites.seatInfo(...a);
export const createInvite = (...a: Parameters<InvitesService["createInvite"]>) => s().invites.createInvite(...a);
export const listInvites = (...a: Parameters<InvitesService["listInvites"]>) => s().invites.listInvites(...a);
export const revokeInvite = (...a: Parameters<InvitesService["revokeInvite"]>) => s().invites.revokeInvite(...a);
export const peekInvite = (...a: Parameters<InvitesService["peekInvite"]>) => s().invites.peekInvite(...a);
export const acceptInvite = (...a: Parameters<InvitesService["acceptInvite"]>) => s().invites.acceptInvite(...a);
export const peekInviteAsMember = (...a: Parameters<InvitesService["peekInviteAsMember"]>) => s().invites.peekInviteAsMember(...a);
export const acceptInviteAsMember = (...a: Parameters<InvitesService["acceptInviteAsMember"]>) => s().invites.acceptInviteAsMember(...a);
export const pendingInvites = (...a: Parameters<InvitesService["pendingInvites"]>) => s().invites.pendingInvites(...a);
export const createInviteAs = (...a: Parameters<InvitesService["createInviteAs"]>) => s().invites.createInviteAs(...a);
export const revokeInviteAs = (...a: Parameters<InvitesService["revokeInviteAs"]>) => s().invites.revokeInviteAs(...a);
export const peekInviteAs = (...a: Parameters<InvitesService["peekInviteAs"]>) => s().invites.peekInviteAs(...a);
export const acceptInviteAs = (...a: Parameters<InvitesService["acceptInviteAs"]>) => s().invites.acceptInviteAs(...a);
export const peekInviteAsMemberAs = (...a: Parameters<InvitesService["peekInviteAsMemberAs"]>) => s().invites.peekInviteAsMemberAs(...a);
export const acceptInviteAsMemberAs = (...a: Parameters<InvitesService["acceptInviteAsMemberAs"]>) => s().invites.acceptInviteAsMemberAs(...a);

// workspace, members and the instance admin
export const workspaceOverview = (...a: Parameters<WorkspacesService["workspaceOverview"]>) => s().workspaces.workspaceOverview(...a);
export const updateMember = (...a: Parameters<WorkspacesService["updateMember"]>) => s().workspaces.updateMember(...a);
export const updateMemberAs = (...a: Parameters<WorkspacesService["updateMemberAs"]>) => s().workspaces.updateMemberAs(...a);
export const removeMember = (...a: Parameters<WorkspacesService["removeMember"]>) => s().workspaces.removeMember(...a);
export const removeMemberAs = (...a: Parameters<WorkspacesService["removeMemberAs"]>) => s().workspaces.removeMemberAs(...a);
export const adminListWorkspaces = (...a: Parameters<WorkspacesService["adminListWorkspaces"]>) => s().workspaces.adminListWorkspaces(...a);
export const getWorkspaceDetail = (...a: Parameters<WorkspacesService["getWorkspaceDetail"]>) => s().workspaces.getWorkspaceDetail(...a);
export const suspendWorkspace = (...a: Parameters<WorkspacesService["suspendWorkspace"]>) => s().workspaces.suspendWorkspace(...a);
export const restoreWorkspace = (...a: Parameters<WorkspacesService["restoreWorkspace"]>) => s().workspaces.restoreWorkspace(...a);
