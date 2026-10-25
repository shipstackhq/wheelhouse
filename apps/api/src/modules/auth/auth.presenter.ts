import { csrfToken } from "../../common/http/csrf";
import type { WorkspaceRole } from "../../db/schema";
import { schema } from "../../db";
import { avatarUrl, workspaceImageUrl } from "../images/index";
import { isInstanceAdmin } from "./auth-policy";
import type { Human } from "./sessions.service";

/** Pure: the rows of the auth tables as the API and the web app see them. Nothing here reads the database. */

/** Who is signed in, as the web app sees it. `csrfToken` is what to send as X-CSRF-Token on every state-changing request. */
export function meView(h: Human, sessionToken: string) {
  return {
    user: { id: h.user.id, name: h.user.name, email: h.user.email, avatarUrl: avatarUrl(h.user.id, h.user.avatarKey) },
    workspace: { id: h.workspace.id, name: h.workspace.name, imageUrl: workspaceImageUrl(h.workspace.id, h.workspace.imageKey) },
    role: h.membership.role,
    tags: h.membership.tags,
    isInstanceAdmin: isInstanceAdmin(h.user.email),
    csrfToken: csrfToken(sessionToken),
  };
}

export type WorkspaceMember = { userId: string; name: string; email: string; role: WorkspaceRole; tags: string[] };

export const memberView = (u: { id: string; name: string; email: string }, m: { role: WorkspaceRole; tags: string[] }): WorkspaceMember => ({
  userId: u.id,
  name: u.name,
  email: u.email,
  role: m.role,
  tags: m.tags,
});

export type KeyView = { id: string; name: string; prefix: string; createdAt: Date; lastUsedAt: Date | null; revokedAt: Date | null; canWriteDocs: boolean; teams: { key: string; name: string }[] };

export const keyView = (k: typeof schema.apiKeys.$inferSelect, teams: KeyView["teams"] = []): KeyView => ({
  id: k.id,
  name: k.name,
  prefix: k.prefix,
  createdAt: k.createdAt,
  lastUsedAt: k.lastUsedAt,
  revokedAt: k.revokedAt,
  canWriteDocs: k.capabilities.includes("docs:write"),
  teams,
});

/** The answer to creating an invite: the link carries the token in its #fragment, so it stays out of server logs and Referer headers. */
export const inviteLinkView = (inv: { id: string; email: string; kind: "new_workspace" | "join_workspace"; expiresAt: Date; token: string }, origin: string) => ({
  id: inv.id,
  email: inv.email,
  kind: inv.kind,
  expiresAt: inv.expiresAt,
  link: `${origin.replace(/\/+$/, "")}/invite#${inv.token}`,
});
