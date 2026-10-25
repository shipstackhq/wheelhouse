import { z } from "zod";
import { anything, text, textOrUndefined } from "../../../common/pipes/lenient";

/** Sign in: `{ email, password }`. The service judges them. */
export const loginDto = z.object({ email: text, password: text });
export type LoginDto = z.infer<typeof loginDto>;

/** Sign up: `{ name, email, password, workspace }`. */
export const signupDto = z.object({ name: text, email: text, password: text, workspace: text });
export type SignupDto = z.infer<typeof signupDto>;

/** `{ keyId?, teamKey? }`: reset an agent's queue, in one team or everywhere. */
export const markAllSeenDto = z.object({ keyId: textOrUndefined, teamKey: textOrUndefined });
export type MarkAllSeenDto = z.infer<typeof markAllSeenDto>;

/** `{ name, teams? }`: create an API key. */
export const createKeyDto = z.object({ name: text, teams: anything });
export type CreateKeyDto = z.infer<typeof createKeyDto>;

/** `{ docsWrite?, teams? }`: change a key. The handler checks that one of them is sent and that `docsWrite` is a boolean. */
export const patchKeyDto = z.object({ docsWrite: anything, teams: anything });
export type PatchKeyDto = z.infer<typeof patchKeyDto>;

/** `{ workspaceId }`: switch the session's workspace. */
export const switchWorkspaceDto = z.object({ workspaceId: text });
export type SwitchWorkspaceDto = z.infer<typeof switchWorkspaceDto>;

/** `{ current, next }`: change the password. */
export const changePasswordDto = z.object({ current: text, next: text });
export type ChangePasswordDto = z.infer<typeof changePasswordDto>;

/** `{ confirm, reason }`: suspend a workspace (instance admins). */
export const suspendWorkspaceDto = z.object({ confirm: text, reason: text });
export type SuspendWorkspaceDto = z.infer<typeof suspendWorkspaceDto>;

/** `{ kind, email, role, tags, workspace, teams }`: create an invite. */
export const createInviteDto = z.object({ kind: anything, email: text, role: anything, tags: anything, workspace: text, teams: anything });
export type CreateInviteDto = z.infer<typeof createInviteDto>;

/** `{ token }`: look at, or accept as a member, an invite. */
export const inviteTokenDto = z.object({ token: text });
export type InviteTokenDto = z.infer<typeof inviteTokenDto>;

/** `{ token, name, password, confirm }`: accept an invite as a new person. */
export const acceptInviteDto = z.object({ token: text, name: text, password: text, confirm: text });
export type AcceptInviteDto = z.infer<typeof acceptInviteDto>;

/** `{ role, tags }`: change a workspace member. */
export const updateMemberDto = z.object({ role: anything, tags: anything });
export type UpdateMemberDto = z.infer<typeof updateMemberDto>;
