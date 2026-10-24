// The map module's public surface: the only file another module may import. The Nest module class is not exported here, so a plain helper's importer never loads this module's controllers; app.imports.ts imports it from map.module (docs/nest-architecture.md).
// The services are what converted modules inject; the plain functions are shims for the callers not converted yet (map.legacy.ts) and go when the last one moves.
export { GraphService } from "./graph.service";
export { DecisionsService } from "./decisions.service";
export { FreshnessService } from "./freshness.service";
export { SessionsService } from "./sessions.service";
export { BriefingService } from "./briefing.service";
export { normPath } from "./map.rules";
export { getGraph, landedHashesFor, maybeDraftDoc, noteIssueActivity, resolveNode, upsertNode } from "./map.legacy";
