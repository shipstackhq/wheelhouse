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
export * from "./service-issues";
export * from "./service-map";
export * from "./service-repositories";
export * from "./service-freshness";
export * from "./service-decisions";
export * from "./service-queue";
export * from "./service-checklist";
export * from "../modules/docs/docs";
