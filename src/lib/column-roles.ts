/**
 * Column roles (WH-86). A column's name is for display and can be renamed; its role says what stage of work it stands
 * for, and is what rules and reports key off. A column with no role (say "Blocked") is never the target of an automatic
 * move and never counts as done. Several columns may share a role: "the review column" is the first one in board order.
 *
 * Pure and dependency-free so the schema, the service layer, the rules and the UI can all import it.
 */

export const COLUMN_ROLES = ["backlog", "todo", "in_progress", "review", "done"] as const;
export type ColumnRole = (typeof COLUMN_ROLES)[number];

export type RoleColumn = { id?: string; name: string; role: ColumnRole | null };

/** What a new project's board starts with. */
export const DEFAULT_COLUMN_DEFS: { name: string; role: ColumnRole }[] = [
  { name: "Backlog", role: "backlog" },
  { name: "Todo", role: "todo" },
  { name: "In Progress", role: "in_progress" },
  { name: "Review", role: "review" },
  { name: "Done", role: "done" },
];

/** "In Progress", "in-progress" and "in_progress" are all the in_progress role; anything else is no role. */
export function roleFromText(text: string): ColumnRole | null {
  const key = text.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return (COLUMN_ROLES as readonly string[]).includes(key) ? (key as ColumnRole) : null;
}

/** The first column (in the order given, which should be board order) that has this role. */
export function columnForRole<C extends RoleColumn>(columns: C[], role: ColumnRole): C | undefined {
  return columns.find((c) => c.role === role);
}

export const hasRole = (c: Pick<RoleColumn, "role"> | null | undefined, ...roles: ColumnRole[]) => !!c?.role && roles.includes(c.role);

/** Ids of the columns with this role. */
export const idsWithRole = (columns: (RoleColumn & { id: string })[], role: ColumnRole) => new Set(columns.filter((c) => c.role === role).map((c) => c.id));
