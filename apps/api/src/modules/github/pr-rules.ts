/**
 * What a pull request event does to the issue it names (WH-20). Pure, so the rules can be tested exactly.
 *
 *   (statuses are found by role: review, in_progress, done; names do not matter)
 *   opened / reopened / ready for review  -> Review
 *   merged                               -> Review if it was earlier; otherwise left alone (a person closes the issue)
 *   closed without merging               -> back to In Progress, but only from Review
 *   draft pull requests                  -> left alone until they are ready
 *   an issue in Done                     -> never moved
 *   an issue in Canceled                 -> never moved
 *   the issue was moved by someone else in the last few minutes -> left alone, and the comment says so
 */

import { statusForRole, hasRole, type RoleStatus } from "@wheelhouse/shared/status-roles";

export const RECENT_MOVE_MS = 10 * 60_000;

export type PrAction = "opened" | "reopened" | "ready_for_review" | "synchronize" | "edited" | "closed" | "converted_to_draft" | string;

export type MoveInput = {
  action: PrAction;
  merged: boolean;
  draft: boolean;
  /** The status the issue is in now. */
  status: RoleStatus;
  /** The team's statuses in board order, so "earlier than the review status" can be decided. */
  statuses: RoleStatus[];
  /** When someone other than GitHub last moved this issue, and who. */
  lastMove?: { at: Date; by: string } | null;
  now: Date;
  recentMs?: number;
};

export type MoveDecision = { move: string | null; note: string | null };

const same = (a: RoleStatus, b: RoleStatus) => (a.id !== undefined && b.id !== undefined ? a.id === b.id : a.name === b.name);
const NONE: MoveDecision = { move: null, note: null };

export function decideMove(i: MoveInput): MoveDecision {
  // Statuses are found by role, never by name, so a board can rename them (WH-86). No review status: leave issues alone.
  const review = statusForRole(i.statuses, "review");
  const progress = statusForRole(i.statuses, "in_progress");
  const inReviewOrDone = hasRole(i.status, "review", "done", "canceled");

  let target: RoleStatus | undefined;
  let why = "";

  if (i.action === "closed" && i.merged) {
    if (inReviewOrDone) return NONE;
    const here = i.statuses.findIndex((c) => same(c, i.status));
    const reviewAt = review ? i.statuses.findIndex((c) => same(c, review)) : -1;
    if (here < 0 || reviewAt < 0 || here >= reviewAt) return NONE;
    target = review;
    why = "merged";
  } else if (i.action === "closed") {
    if (!hasRole(i.status, "review")) return NONE;
    target = progress;
    why = "closed without merging";
  } else if (["opened", "reopened", "ready_for_review"].includes(i.action)) {
    if (i.draft) return NONE; // not ready for anyone's eyes yet
    if (inReviewOrDone) return NONE;
    target = review;
    why = i.action === "reopened" ? "reopened" : "opened";
  } else {
    return NONE; // pushes, edits and label changes never move an issue
  }

  if (!target) return NONE;

  const window = i.recentMs ?? RECENT_MOVE_MS;
  if (i.lastMove && i.now.getTime() - i.lastMove.at.getTime() < window) {
    const mins = Math.max(1, Math.round((i.now.getTime() - i.lastMove.at.getTime()) / 60_000));
    return { move: null, note: `left in ${i.status.name}: ${i.lastMove.by} moved it ${mins} minute${mins === 1 ? "" : "s"} ago, so the pull request (${why}) did not move it` };
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
