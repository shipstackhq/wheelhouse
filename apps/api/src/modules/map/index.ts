// The map module's public surface: the only file another module may import. The Nest module class is not exported here, so a plain helper's importer never loads this module's controllers; app.imports.ts imports it from map.module (docs/nest-architecture.md).
// The services are what converted modules inject. The plain functions (map.legacy.ts) are shims for the tests, which import that file directly, so they are not exported here.
export { GraphService } from "./graph.service";
export { DecisionsService } from "./decisions.service";
export { FreshnessService } from "./freshness.service";
export { SessionsService } from "./sessions.service";
export { AskService } from "./ask.service";
export { anchorScore, anchoredBy, ACTIVE_SESSION_MS, normPath, askEnabled, renderMap } from "./map.rules";
export type { NodeRow } from "./map.repository";
export { CHANGES_REPORTED, FILES_LANDED, SESSION_SYNCED, type ChangesReported, type ChangesReportedResult, type FilesLanded, type FilesLandedResult, type SessionSynced } from "./map.events";
