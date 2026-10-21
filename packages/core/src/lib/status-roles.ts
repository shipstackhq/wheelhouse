/**
 * Status roles (WH-86). A status's name is for display and can be renamed; its role says what stage of work it stands
 * for, and is what rules and reports key off. A status with no role (say "Blocked") is never the target of an automatic
 * move and never counts as done. Several statuses may share a role ("Code review" and "Design review" are both review): the
 * one marked as the role's default is the target of an automatic move, and with none marked it is the first in board order.
 * Done and canceled are the two closed roles: an issue in either is no longer open work.
 *
 * Pure and dependency-free so the schema, the service layer, the rules and the UI can all import it.
 */

export const STATUS_ROLES = ["backlog", "todo", "in_progress", "review", "done", "canceled"] as const;
export type StatusRole = (typeof STATUS_ROLES)[number];

/** The order roles are laid out in on a board and in a list: a status never sits after one of a later role. */
export const ROLE_ORDER: readonly StatusRole[] = ["backlog", "todo", "in_progress", "review", "done", "canceled"];
export const roleRank = (role: StatusRole) => ROLE_ORDER.indexOf(role);

/** A team always has at least one status of each of these (review is optional: without one, pull requests leave issues alone). */
export const REQUIRED_ROLES = ["backlog", "todo", "in_progress", "done", "canceled"] as const satisfies readonly StatusRole[];

/** The longest a status name can be. */
export const STATUS_NAME_MAX = 40;

/** The roles of statuses whose issues are finished, one way or the other. */
export const CLOSED_ROLES = ["done", "canceled"] as const satisfies readonly StatusRole[];

export type RoleStatus = { id?: string; name: string; role: StatusRole | null; isDefault?: boolean };

/** What a new team's board starts with. */
export const DEFAULT_STATUS_DEFS: { name: string; role: StatusRole }[] = [
  { name: "Backlog", role: "backlog" },
  { name: "Todo", role: "todo" },
  { name: "In Progress", role: "in_progress" },
  { name: "Review", role: "review" },
  { name: "Done", role: "done" },
  { name: "Canceled", role: "canceled" },
];

/** "In Progress", "in-progress" and "in_progress" are all the in_progress role; anything else is no role. */
export function roleFromText(text: string): StatusRole | null {
  const key = text.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return (STATUS_ROLES as readonly string[]).includes(key) ? (key as StatusRole) : null;
}

/** The status an automatic move to this role goes to: the one marked default, else the first (in the order given, which should be board order). */
export function statusForRole<C extends RoleStatus>(statuses: C[], role: StatusRole): C | undefined {
  const withRole = statuses.filter((c) => c.role === role);
  return withRole.find((c) => c.isDefault) ?? withRole[0];
}

export const hasRole = (c: Pick<RoleStatus, "role"> | null | undefined, ...roles: StatusRole[]) => !!c?.role && roles.includes(c.role);

/** Whether the status is done or canceled. A status with no role is never closed. */
export const isClosed = (c: Pick<RoleStatus, "role"> | null | undefined) => hasRole(c, ...CLOSED_ROLES);

/** Ids of the statuses with this role. */
export const idsWithRole = (statuses: (RoleStatus & { id: string })[], role: StatusRole) => new Set(statuses.filter((c) => c.role === role).map((c) => c.id));

/** Ids of the statuses with any of these roles. */
export const idsWithRoles = (statuses: (RoleStatus & { id: string })[], ...roles: StatusRole[]) => new Set(statuses.filter((c) => hasRole(c, ...roles)).map((c) => c.id));
