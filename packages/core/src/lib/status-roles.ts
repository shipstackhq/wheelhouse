/**
 * Status roles (WH-86). A status's name is for display and can be renamed; its role says what stage of work it stands
 * for, and is what rules and reports key off. A status with no role (say "Blocked") is never the target of an automatic
 * move and never counts as done. Several statuses may share a role: "the review status" is the first one in board order.
 *
 * Pure and dependency-free so the schema, the service layer, the rules and the UI can all import it.
 */

export const STATUS_ROLES = ["backlog", "todo", "in_progress", "review", "done"] as const;
export type StatusRole = (typeof STATUS_ROLES)[number];

export type RoleStatus = { id?: string; name: string; role: StatusRole | null };

/** What a new team's board starts with. */
export const DEFAULT_STATUS_DEFS: { name: string; role: StatusRole }[] = [
  { name: "Backlog", role: "backlog" },
  { name: "Todo", role: "todo" },
  { name: "In Progress", role: "in_progress" },
  { name: "Review", role: "review" },
  { name: "Done", role: "done" },
];

/** "In Progress", "in-progress" and "in_progress" are all the in_progress role; anything else is no role. */
export function roleFromText(text: string): StatusRole | null {
  const key = text.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return (STATUS_ROLES as readonly string[]).includes(key) ? (key as StatusRole) : null;
}

/** The first status (in the order given, which should be board order) that has this role. */
export function statusForRole<C extends RoleStatus>(statuses: C[], role: StatusRole): C | undefined {
  return statuses.find((c) => c.role === role);
}

export const hasRole = (c: Pick<RoleStatus, "role"> | null | undefined, ...roles: StatusRole[]) => !!c?.role && roles.includes(c.role);

/** Ids of the statuses with this role. */
export const idsWithRole = (statuses: (RoleStatus & { id: string })[], role: StatusRole) => new Set(statuses.filter((c) => c.role === role).map((c) => c.id));
