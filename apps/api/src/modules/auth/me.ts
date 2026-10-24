import { isInstanceAdmin } from "./auth-policy";
import type { Human } from "./auth-core";
import { avatarUrl, workspaceImageUrl } from "../../lib/images";
import { csrfToken } from "../../web/csrf";

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
