/**
 * Which part of the API a process serves. The same build runs as one process ("all", the default) or, later, as separate ones:
 * "api" serves people and agents (/api/app, /api/v1, /mcp, GitHub), "daemon" serves paired machines (/api/daemon) and runs the job
 * sweep. Every role serves /api/health. A role decides which modules are loaded; the code of a module does not change with it.
 */
export type ServiceRole = "api" | "daemon" | "all";

const ROLES: readonly ServiceRole[] = ["api", "daemon", "all"];

/** SERVICE_ROLE, or "all" when it is unset. A value that is not a role is refused at boot, so a typo cannot silently serve nothing. */
export function readServiceRole(env: Record<string, string | undefined>): ServiceRole {
  const v = env.SERVICE_ROLE?.trim();
  if (!v) return "all";
  if ((ROLES as readonly string[]).includes(v)) return v as ServiceRole;
  throw new Error(`SERVICE_ROLE must be one of ${ROLES.join(", ")} (got "${v}")`);
}

export const servesApi = (role: ServiceRole) => role === "api" || role === "all";
export const servesDaemon = (role: ServiceRole) => role === "daemon" || role === "all";
