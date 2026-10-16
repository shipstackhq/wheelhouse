import { isInstanceAdmin } from "@wheelhouse/core/lib/auth-policy";
import type { Human } from "@wheelhouse/core/lib/auth-core";
import { csrfToken } from "./csrf";

/** Who is signed in, as the web app sees it. `csrfToken` is what to send as X-CSRF-Token on every state-changing request. */
export function meView(h: Human, sessionToken: string) {
  return {
    user: { id: h.user.id, name: h.user.name, email: h.user.email },
    team: { id: h.team.id, name: h.team.name },
    role: h.membership.role,
    isInstanceAdmin: isInstanceAdmin(h.user.email),
    csrfToken: csrfToken(sessionToken),
  };
}
