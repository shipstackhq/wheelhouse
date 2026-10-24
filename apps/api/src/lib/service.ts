import { ServiceError } from "./service-core";

/**
 * The single write path for Wheelhouse. UI server actions, the REST API and the
 * MCP server all call into here, so every mutation is workspace-scoped, versioned
 * where it matters, and recorded in `events` (the activity feed + AI queue).
 *
 * The functions live in the service-* files, one per area, ready to move into
 * their modules (docs/nest-architecture.md); this file only re-exports them.
 */
export { ServiceError };
export * from "./service-core";
export * from "../modules/teams/teams";
export * from "../modules/issues/issues";
export * from "../modules/issues/issue-nodes";
export * from "../modules/map/graph";
export * from "../modules/github/repositories";
export * from "../modules/map/freshness";
export * from "../modules/map/decisions";
export * from "./service-queue";
export * from "./service-checklist";
export * from "../modules/docs/docs";
