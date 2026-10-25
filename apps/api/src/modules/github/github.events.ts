import type { Actor } from "../../common/actor";
import type { RepositoryRow } from "./github.repository";

/**
 * What the github module tells the others, through Nest's event emitter (`@nestjs/event-emitter`). github owns these names and payloads
 * and emits with `await emitter.emitAsync(name, payload)`; a listener (the map's and the issues module's) declares `@OnEvent(name, { suppressErrors: false })`.
 * `emitAsync` awaits every listener in the emitter's own async context, so a listener runs inside the emitter's transaction and its error
 * rejects the github call, as if github had called it. `suppressErrors: false` matters: the default logs a listener's error and swallows it.
 */

/** A repository was created, registered from a client report, had its lifecycle changed, or was retired: its system node on the map follows. */
export const REPOSITORY_CHANGED = "github.repository.changed";
export type RepositoryChanged = { actor: Actor; teamId: string; repository: RepositoryRow };

/** A push to a connected repository's default branch: the files that changed (path to content hash, null for deleted) are to be landed on the map. */
export const PUSH_LANDED = "github.push.landed";
export type PushLanded = {
  actor: Actor;
  teamKey: string;
  sha: string;
  branch: string;
  files: Record<string, string | null>;
  /** The repository's slug. */
  repository: string;
};

/** A pull request calls for its linked issue to move to a status (an id, a name or a role): the issues module moves it, as the actor, exactly as `moveIssue` would. */
export const ISSUE_MOVE_REQUESTED = "github.issue.move_requested";
export type IssueMoveRequested = { actor: Actor; ref: string; status: string };

/** A pull request or a CI result calls for a comment on its linked issue: the issues module adds it, as the actor, exactly as `addComment` would. */
export const ISSUE_COMMENT_REQUESTED = "github.issue.comment_requested";
export type IssueCommentRequested = { actor: Actor; ref: string; body: string };
