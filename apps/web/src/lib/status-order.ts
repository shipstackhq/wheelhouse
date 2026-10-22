import { ROLE_ORDER, type StatusRole } from "@wheelhouse/core/lib/status-roles";

/** What a status's role is called on screen. */
export const ROLE_LABEL: Record<StatusRole, string> = {
  backlog: "Backlog",
  todo: "Todo",
  in_progress: "In progress",
  review: "Review",
  done: "Done",
  canceled: "Canceled",
};

export type Ordered = { id: string; role: StatusRole };

export type Group<T extends Ordered> = { role: StatusRole; label: string; items: T[] };

/** The statuses grouped by role, in the order of the roles, each group in board order. A role nobody has is not a group. */
export function groupStatuses<T extends Ordered>(list: T[]): Group<T>[] {
  return ROLE_ORDER.map((role) => ({ role, label: ROLE_LABEL[role], items: list.filter((s) => s.role === role) })).filter((g) => g.items.length);
}

/**
 * The whole list's ids after `fromId` is dropped where `toId` is, both in the group of `role`. Only that group's own places in the list are
 * refilled, so a status of another role that sits between them stays exactly where it was.
 */
export function reorderWithinGroup(all: Ordered[], role: StatusRole, fromId: string, toId: string): string[] {
  const members = all.filter((s) => s.role === role).map((s) => s.id);
  const from = members.indexOf(fromId);
  const to = members.indexOf(toId);
  if (from < 0 || to < 0 || from === to) return all.map((s) => s.id);
  const moved = [...members];
  moved.splice(to, 0, ...moved.splice(from, 1));
  let next = 0;
  return all.map((s) => (s.role === role ? moved[next++] : s.id));
}
