import type { Actor } from "../../common/actor";

/**
 * What the issues module tells the others, through Nest's event emitter. Emitted after the change has committed, with `emitAsync`; a
 * listener's failure is logged by the emitter and never undoes the change.
 */

/** An issue's delegate was set, changed or cleared (WH-116): the daemon module starts or stops its run. `agentId` null means cleared. */
export const ISSUE_DELEGATED = "issues.issue.delegated";
export type IssueDelegated = { actor: Actor; issueId: string; ref: string; agentId: string | null };

/** Someone commented on an issue (WH-118): the daemon module carries on an agent run that stopped with a question. */
export const ISSUE_COMMENTED = "issues.issue.commented";
export type IssueCommented = { actor: Actor; issueId: string; ref: string; body: string };
