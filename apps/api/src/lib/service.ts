import { ServiceError } from "../common/service-error";

/**
 * The legacy barrel, kept for the MCP and v1 tool layer (tools.ts) until its redesign (docs/nest-architecture.md). Nothing else
 * imports it: every module and test takes what it needs from the file that defines it, and modules reach each other through
 * their index.ts. Do not add importers.
 */
export { ServiceError };
export * from "../platform/events/emit";
export * from "../platform/database/transaction";
export * from "../common/uuid";
export { createTeam, deleteTeam, listTeams, requireTeam, updateTeam } from "../modules/teams/teams.legacy";
export * from "../modules/issues/issues";
export * from "../modules/issues/issue-nodes";
export * from "../modules/map/graph";
export { findOrCreateRepository, listRepositories } from "../modules/github/github.legacy";
export * from "../modules/map/freshness";
export * from "../modules/map/decisions";
export * from "./service-queue";
export * from "../modules/dashboard/checklist";
export { createDoc, deleteDoc, getDoc, linkDocNode, listDocs, listDocTemplates, markDocFresh, moveDoc, searchDocs, suggestDocAnchors, updateDoc } from "../modules/docs/docs.legacy";
