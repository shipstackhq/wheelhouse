import type { CiPolicy } from "../../db/tables/github";

export type VerdictState = "green" | "red" | "pending" | "stalled";
export type Verdict = { state: VerdictState; reasons: string[] };
type Check = { status: string; conclusion: string | null };
export type SelfCheck = { name: string; required: boolean; status: string };

export type VerdictInputs = {
  /** The policy in effect: a confirmed one, else the default (see `effectivePolicy`). */
  policy: CiPolicy;
  /** The checks GitHub requires of the default branch (`CiDetected.requiredFromProtection`). */
  protectionRequired: string[];
  /** The self-check results for this commit; null when none ran on it. */
  selfChecks: SelfCheck[] | null;
  /** The pull request's checks for this commit. */
  checks: Record<string, Check>;
  pushedAt: Date;
  now: Date;
};

export const DEFAULT_POLICY: CiPolicy = { mode: "github_checks", required: "all", optionalIfAbsent: [], startTimeoutMinutes: 10 };

const RANK: Record<VerdictState, number> = { green: 0, pending: 1, stalled: 2, red: 3 };
/** The worst of several verdicts, `red > stalled > pending > green`, with every reason kept. */
export const worst = (vs: Verdict[]): Verdict => ({ state: vs.reduce<VerdictState>((w, v) => (RANK[v.state] > RANK[w] ? v.state : w), "green"), reasons: vs.flatMap((v) => v.reasons) });

const FAILED = ["failure", "timed_out", "cancelled", "action_required", "startup_failure"];

/**
 * WH-190 (ADR-26): the one verdict of a commit, from its policy, self-checks and pull request checks. Pure: no I/O, so every rule is a table row in a test.
 * Required self-checks that did not pass are red; with no CI (`none`) self-checks are the only evidence; with CI, the required checks decide
 * (red if one failed, pending while one runs or has not appeared); and pending with no check reported at all past the start timeout is stalled.
 */
export function verdictFor(i: VerdictInputs): Verdict {
  const { policy } = i;
  if (i.selfChecks) {
    const bad = i.selfChecks.filter((c) => c.required && c.status !== "passed");
    if (bad.length) return { state: "red", reasons: bad.map((c) => `self-check ${c.name} ${c.status === "failed" ? "failed" : "could not run"}`) };
  } else if (policy.mode === "none") return stall(i, ["no evidence"]);
  if (policy.mode === "none") return { state: "green", reasons: [] };

  const seen = Object.keys(i.checks);
  const named = policy.required === "all" ? seen : policy.required === "branch_protection" ? i.protectionRequired : policy.required;
  const required = named.length || policy.required !== "branch_protection" ? named : seen; // protection naming nothing: every check counts
  const red: string[] = [];
  const pending: string[] = [];
  for (const name of required) {
    const c = i.checks[name];
    if (!c) {
      if (!policy.optionalIfAbsent.includes(name)) pending.push(`CI job ${name} has not reported`);
    } else if (c.status !== "completed") pending.push(`CI job ${name} is still running`);
    else if (c.conclusion && FAILED.includes(c.conclusion)) red.push(`CI job ${name} failed`);
  }
  if (red.length) return { state: "red", reasons: red };
  if (!seen.length && !pending.length) pending.push("no CI has reported");
  return pending.length ? stall(i, pending) : { state: "green", reasons: [] };
}

/** Pending, or stalled once the policy's start timeout has passed with no check reported at all. */
function stall(i: VerdictInputs, reasons: string[]): Verdict {
  const late = i.now.getTime() - i.pushedAt.getTime() > i.policy.startTimeoutMinutes * 60_000;
  return { state: !Object.keys(i.checks).length && late ? "stalled" : "pending", reasons };
}
