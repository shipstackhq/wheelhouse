import type { Database } from "../../platform/database/database";
import type { AskService } from "./ask.service";
import type { DecisionsService } from "./decisions.service";
import type { FreshnessService } from "./freshness.service";
import type { GraphService } from "./graph.service";
import type { SessionsService } from "./sessions.service";

/**
 * Temporary. Code that is not converted yet (the docs and issues modules, tests) still calls plain
 * functions; these are those functions, each one line forwarding to the live service. `MapModule.onModuleInit` points them at the
 * services Nest built, so nothing works before the application has booted (tests call `testApp()`). A function that takes a `q` runs on
 * it through `Database.within`, so a caller's own transaction stays the one the service uses. Delete this file when the last caller
 * moves to the services.
 */
type Live = { db: Database; graph: GraphService; decisions: DecisionsService; freshness: FreshnessService; sessions: SessionsService; ask: AskService };
let live: Live | undefined;

export function bindMapLegacy(services: Live) {
  live = services;
}
const s = (): Live => live ?? (() => { throw new Error("The map module is not booted: start the Nest application (tests: await testApp()) before calling the legacy functions"); })();

// graph
export const getGraph = (...a: Parameters<GraphService["getGraph"]>) => s().graph.getGraph(...a);
export const getNode = (...a: Parameters<GraphService["getNode"]>) => s().graph.getNode(...a);
export const upsertNode = (...a: Parameters<GraphService["upsertNode"]>) => s().graph.upsertNode(...a);
export const deleteNode = (...a: Parameters<GraphService["deleteNode"]>) => s().graph.deleteNode(...a);
export const upsertEdge = (...a: Parameters<GraphService["upsertEdge"]>) => s().graph.upsertEdge(...a);
export const upsertFlow = (...a: Parameters<GraphService["upsertFlow"]>) => s().graph.upsertFlow(...a);

// decisions and glossary
export const listDecisions = (...a: Parameters<DecisionsService["listDecisions"]>) => s().decisions.listDecisions(...a);
export const upsertDecision = (...a: Parameters<DecisionsService["upsertDecision"]>) => s().decisions.upsertDecision(...a);
export const upsertTerm = (...a: Parameters<DecisionsService["upsertTerm"]>) => s().decisions.upsertTerm(...a);

// freshness, landing and drafts
export const reportChanges = (...a: Parameters<FreshnessService["reportChanges"]>) => s().freshness.reportChanges(...a);
export const land = (...a: Parameters<FreshnessService["land"]>) => s().freshness.land(...a);
export const resolveDraft = (...a: Parameters<FreshnessService["resolveDraft"]>) => s().freshness.resolveDraft(...a);

// sessions
export const sessionSync = (...a: Parameters<SessionsService["sessionSync"]>) => s().sessions.sessionSync(...a);

// Ask
export const askMap = (...a: Parameters<AskService["askMap"]>) => s().ask.askMap(...a);
