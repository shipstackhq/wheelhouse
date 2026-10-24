import type { Actor } from "../../common/actor";
import type { RepositoryRow } from "./github.repository";

/**
 * What the github module tells the others, through Nest's event emitter (`@nestjs/event-emitter`). github owns these names and payloads
 * and emits with `await emitter.emitAsync(name, payload)`; a listener (the map's, today) declares `@OnEvent(name, { suppressErrors: false })`.
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
