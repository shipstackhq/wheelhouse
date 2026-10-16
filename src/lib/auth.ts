import "server-only";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { clientIp } from "@wheelhouse/core/lib/rate-limit";
import { userForSessionToken, type Actor } from "@wheelhouse/core/lib/access";
import { actorFromCredentials, currentMembership, endSession, humanFromSession, SESSION_COOKIE, startSession } from "@wheelhouse/core/lib/auth-core";

export { currentMembership };
// Passwords, tokens and the signup rules are @wheelhouse/core's; the API uses the same ones.
export { hashPassword, randomToken, verifyPassword } from "@wheelhouse/core/lib/auth-core";
export { signupAllowed } from "@wheelhouse/core/lib/accounts";

// Everything that decides who may come in lives in access.ts (testable without Next.js); re-exported so the rest
// of the app keeps importing it from here.
export {
  actorForKey,
  AuthError,
  RateLimitError,
  SuspendedError,
  TEAM_SUSPENDED_MESSAGE,
  sha256,
  userForSessionToken,
  userTeamSuspended,
  type Actor,
} from "@wheelhouse/core/lib/access";

const COOKIE = SESSION_COOKIE;

/** Start a session and set the cookie (the same cookie the API sets). */
export async function createSession(userId: string) {
  const { token, expiresAt } = await startSession(userId);
  (await cookies()).set(COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: expiresAt,
  });
}

export async function destroySession() {
  const jar = await cookies();
  await endSession(jar.get(COOKIE)?.value);
  jar.delete(COOKIE);
}

export async function currentUser() {
  const token = (await cookies()).get(COOKIE)?.value;
  if (!token) return null;
  return userForSessionToken(token);
}

/** For pages + server actions. Redirects to /login when signed out. */
export async function requireHuman() {
  const human = await humanFromSession((await cookies()).get(COOKIE)?.value);
  if (!human) redirect("/login");
  return human;
}

/**
 * For /api/v1 and /mcp. Accepts `Authorization: Bearer wh_…` (agents)
 * or a session cookie (humans hitting the API from the browser).
 */
export async function actorFromRequest(): Promise<Actor> {
  const h = await headers();
  return actorFromCredentials({ authorization: h.get("authorization"), sessionToken: (await cookies()).get(COOKIE)?.value, ip: clientIp(h) });
}
