/**
 * What a pull request event does to the ticket it names (WH-20). Pure, so the rules can be tested exactly.
 *
 *   (columns are found by role: review, in_progress, done; names do not matter)
 *   opened / reopened / ready for review  -> Review
 *   merged                               -> Review if it was earlier; otherwise left alone (a person closes the ticket)
 *   closed without merging               -> back to In Progress, but only from Review
 *   draft pull requests                  -> left alone until they are ready
 *   a ticket in Done                     -> never moved
 *   a ticket in a custom column (no role) -> never moved: a person put it outside the workflow on purpose (WH-86)
 *   the ticket was moved by someone else in the last few minutes -> left alone, and the comment says so
 */

import { columnForRole, hasRole, type RoleColumn } from "../column-roles";

export const RECENT_MOVE_MS = 10 * 60_000;

export type PrAction = "opened" | "reopened" | "ready_for_review" | "synchronize" | "edited" | "closed" | "converted_to_draft" | string;

export type MoveInput = {
  action: PrAction;
  merged: boolean;
  draft: boolean;
  /** The column the ticket is in now. */
  column: RoleColumn;
  /** The team's columns in board order, so "earlier than the review column" can be decided. */
  columns: RoleColumn[];
  /** When someone other than GitHub last moved this ticket, and who. */
  lastMove?: { at: Date; by: string } | null;
  now: Date;
  recentMs?: number;
};

export type MoveDecision = { move: string | null; note: string | null };

const same = (a: RoleColumn, b: RoleColumn) => (a.id !== undefined && b.id !== undefined ? a.id === b.id : a.name === b.name);
const NONE: MoveDecision = { move: null, note: null };

export function decideMove(i: MoveInput): MoveDecision {
  if (!i.column.role) return NONE; // custom columns are outside the workflow; automation never moves a ticket out of one
  // Columns are found by role, never by name, so a board can rename them (WH-86). No review column: leave tickets alone.
  const review = columnForRole(i.columns, "review");
  const progress = columnForRole(i.columns, "in_progress");
  const inReviewOrDone = hasRole(i.column, "review", "done");

  let target: RoleColumn | undefined;
  let why = "";

  if (i.action === "closed" && i.merged) {
    if (inReviewOrDone) return NONE;
    const here = i.columns.findIndex((c) => same(c, i.column));
    const reviewAt = review ? i.columns.findIndex((c) => same(c, review)) : -1;
    if (here < 0 || reviewAt < 0 || here >= reviewAt) return NONE;
    target = review;
    why = "merged";
  } else if (i.action === "closed") {
    if (!hasRole(i.column, "review")) return NONE;
    target = progress;
    why = "closed without merging";
  } else if (["opened", "reopened", "ready_for_review"].includes(i.action)) {
    if (i.draft) return NONE; // not ready for anyone's eyes yet
    if (inReviewOrDone) return NONE;
    target = review;
    why = i.action === "reopened" ? "reopened" : "opened";
  } else {
    return NONE; // pushes, edits and label changes never move a ticket
  }

  if (!target) return NONE;

  const window = i.recentMs ?? RECENT_MOVE_MS;
  if (i.lastMove && i.now.getTime() - i.lastMove.at.getTime() < window) {
    const mins = Math.max(1, Math.round((i.now.getTime() - i.lastMove.at.getTime()) / 60_000));
    return { move: null, note: `left in ${i.column.name}: ${i.lastMove.by} moved it ${mins} minute${mins === 1 ? "" : "s"} ago, so the pull request (${why}) did not move it` };
  }
  return { move: target.name, note: `moved to ${target.name}: pull request ${why}` };
}

export type CheckState = "success" | "failure" | "pending";

/** Collapse a pull request's check runs into one state: any failure wins, then anything still running, then success. */
export function ciState(checks: Record<string, { status: string; conclusion: string | null }>): CheckState | null {
  const all = Object.values(checks);
  if (!all.length) return null;
  const failed = ["failure", "timed_out", "cancelled", "action_required", "startup_failure"];
  if (all.some((c) => c.status === "completed" && c.conclusion && failed.includes(c.conclusion))) return "failure";
  if (all.some((c) => c.status !== "completed")) return "pending";
  return "success"; // success, neutral, skipped, stale
}
