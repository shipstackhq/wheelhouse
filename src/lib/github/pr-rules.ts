/**
 * What a pull request event does to the ticket it names (WH-20). Pure, so the rules can be tested exactly.
 *
 *   opened / reopened / ready for review  -> Review
 *   merged                               -> Review if it was earlier; otherwise left alone (a person closes the ticket)
 *   closed without merging               -> back to In Progress, but only from Review
 *   draft pull requests                  -> left alone until they are ready
 *   a ticket in Done                     -> never moved
 *   the ticket was moved by someone else in the last few minutes -> left alone, and the comment says so
 */

export const RECENT_MOVE_MS = 10 * 60_000;

export type PrAction = "opened" | "reopened" | "ready_for_review" | "synchronize" | "edited" | "closed" | "converted_to_draft" | string;

export type MoveInput = {
  action: PrAction;
  merged: boolean;
  draft: boolean;
  /** The column the ticket is in now. */
  column: string;
  /** Column names in board order, so "earlier than Review" can be decided. */
  order: string[];
  /** When someone other than GitHub last moved this ticket, and who. */
  lastMove?: { at: Date; by: string } | null;
  now: Date;
  recentMs?: number;
};

export type MoveDecision = { move: string | null; note: string | null };

const REVIEW = "Review";
const PROGRESS = "In Progress";
const DONE = "Done";

export function decideMove(i: MoveInput): MoveDecision {
  const idx = (c: string) => i.order.findIndex((x) => x.toLowerCase() === c.toLowerCase());
  const here = idx(i.column);
  const reviewAt = idx(REVIEW);
  const progressAt = idx(PROGRESS);
  const lc = i.column.toLowerCase();

  let target: string | null = null;
  let why = "";

  if (i.action === "closed" && i.merged) {
    if (lc === DONE.toLowerCase() || lc === REVIEW.toLowerCase()) return { move: null, note: null };
    if (here >= 0 && reviewAt >= 0 && here < reviewAt) {
      target = REVIEW;
      why = "merged";
    } else return { move: null, note: null };
  } else if (i.action === "closed") {
    if (lc !== REVIEW.toLowerCase()) return { move: null, note: null };
    target = PROGRESS;
    why = "closed without merging";
  } else if (["opened", "reopened", "ready_for_review"].includes(i.action)) {
    if (i.draft) return { move: null, note: null }; // not ready for anyone's eyes yet
    if (lc === DONE.toLowerCase() || lc === REVIEW.toLowerCase()) return { move: null, note: null };
    target = REVIEW;
    why = i.action === "reopened" ? "reopened" : "opened";
  } else {
    return { move: null, note: null }; // pushes, edits and label changes never move a ticket
  }

  if (target === null || (progressAt < 0 && target === PROGRESS) || (reviewAt < 0 && target === REVIEW)) return { move: null, note: null };

  const window = i.recentMs ?? RECENT_MOVE_MS;
  if (i.lastMove && i.now.getTime() - i.lastMove.at.getTime() < window) {
    const mins = Math.max(1, Math.round((i.now.getTime() - i.lastMove.at.getTime()) / 60_000));
    return { move: null, note: `left in ${i.column}: ${i.lastMove.by} moved it ${mins} minute${mins === 1 ? "" : "s"} ago, so the pull request (${why}) did not move it` };
  }
  return { move: target, note: `moved to ${target}: pull request ${why}` };
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
