import type { Actor } from "../../common/actor";

/**
 * What the map tells the others, through Nest's event emitter (`@nestjs/event-emitter`). The map owns these names and payloads and
 * emits with `await emitter.emitAsync(name, payload)`; the docs module's listener declares `@OnEvent(name, { suppressErrors: false })`.
 * `emitAsync` awaits every listener in the emitter's own async context, so a listener runs inside the map's transaction and its error
 * rejects the map's call, as if the map had called it. A listener's return value comes back in `emitAsync`'s array: the map reports
 * what the docs did (which docs it flagged, published or let drift) next to what it did itself, so the answer to the caller and the
 * event row stay what they were.
 */

/** Files were reported changed (a commit, a pull request, an agent session): the docs anchored to them are flagged stale. */
export const CHANGES_REPORTED = "map.changes.reported";
export type ChangesReported = {
  actor: Actor;
  teamId: string;
  /** Normalised paths. */
  files: string[];
  sha?: string;
  summary?: string;
  /** The reported repository's slug, for repository-qualified anchors; none for an old client. */
  repository?: string | null;
};
/** What the docs did about it: the docs it flagged, and the files that some doc anchors (the map adds its own). */
export type ChangesReportedResult = { marked: { id: string; title: string; slug: string; files: string[] }[]; anchored: string[] };

/** Code landed on the default branch: the docs anchored to those files record their hashes, publish their drafts or flag drift. */
export const FILES_LANDED = "map.files.landed";
export type FilesLanded = {
  actor: Actor;
  teamId: string;
  /** Normalised path and content hash (null: deleted), already limited to the team's path. */
  files: (readonly [string, string | null])[];
  /** Initial import: record the hashes as the described baseline without flagging anything. */
  baseline: boolean;
  sha?: string;
  repository?: string | null;
};
/** What the docs did about it, by slug. */
export type FilesLandedResult = { published: string[]; stale: string[]; fresh: string[] };

/** A work session reported the files it touches: the doc drafts it wrote against code it no longer has in flux are discarded. */
export const SESSION_SYNCED = "map.session.synced";
export type SessionSynced = { teamId: string; sessionId: string; touched: string[]; repository?: string | null };
