import type { Database } from "../../platform/database/database";
import type { Q } from "../../platform/database/transaction";
import type { AskService } from "./ask.service";
import type { DecisionsService } from "./decisions.service";
import type { FreshnessService } from "./freshness.service";
import type { GraphService } from "./graph.service";
import type { SessionsService } from "./sessions.service";

/**
 * Temporary. Code that is not converted yet (the MCP tools through lib/service.ts, the docs and issues modules, tests) still calls plain
 * functions; these are those functions, each one line forwarding to the live service. `MapModule.onModuleInit` points them at the
 * services Nest built, so nothing works before the application has booted (tests call `testApp()`). A function that takes a `q` runs on
 * it through `Database.within`, so a caller's own transaction stays the one the service uses. Delete this file when the last caller
 * moves to the services (the MCP redesign moves the tools).
 */
type Live = { db: Database; graph: GraphService; decisions: DecisionsService; freshness: FreshnessService; sessions: SessionsService; ask: AskService };
let live: Live | undefined;

export function bindMapLegacy(services: Live) {
  live = services;
}
const s = (): Live => live ?? (() => { throw new Error("The map module is not booted: start the Nest application (tests: await testApp()) before calling the legacy functions"); })();
const on = <T>(q: Q, fn: () => Promise<T>): Promise<T> => s().db.within(q, fn);

// graph
export const getGraph = (...a: Parameters<GraphService["getGraph"]>) => s().graph.getGraph(...a);
export const resolveNode = (q: Q, ...a: Parameters<GraphService["resolveNode"]>) => on(q, () => s().graph.resolveNode(...a));
export const getNode = (...a: Parameters<GraphService["getNode"]>) => s().graph.getNode(...a);
export const upsertNode = (...a: Parameters<GraphService["upsertNode"]>) => s().graph.upsertNode(...a);
export const landedHashesFor = (q: Q, ...a: Parameters<GraphService["landedHashesFor"]>) => on(q, () => s().graph.landedHashesFor(...a));
export const syncReferences = (...a: Parameters<GraphService["syncReferences"]>) => s().graph.syncReferences(...a);
export const getSchema = (...a: Parameters<GraphService["getSchema"]>) => s().graph.getSchema(...a);
export const saveLayout = (...a: Parameters<GraphService["saveLayout"]>) => s().graph.saveLayout(...a);
export const deleteNode = (...a: Parameters<GraphService["deleteNode"]>) => s().graph.deleteNode(...a);
export const upsertEdge = (...a: Parameters<GraphService["upsertEdge"]>) => s().graph.upsertEdge(...a);
export const deleteEdge = (...a: Parameters<GraphService["deleteEdge"]>) => s().graph.deleteEdge(...a);
export const unlinkNodes = (...a: Parameters<GraphService["unlinkNodes"]>) => s().graph.unlinkNodes(...a);
export const upsertFlow = (...a: Parameters<GraphService["upsertFlow"]>) => s().graph.upsertFlow(...a);
export const deleteFlow = (...a: Parameters<GraphService["deleteFlow"]>) => s().graph.deleteFlow(...a);

// decisions and glossary
export const listDecisions = (...a: Parameters<DecisionsService["listDecisions"]>) => s().decisions.listDecisions(...a);
export const upsertDecision = (...a: Parameters<DecisionsService["upsertDecision"]>) => s().decisions.upsertDecision(...a);
export const listTerms = (...a: Parameters<DecisionsService["listTerms"]>) => s().decisions.listTerms(...a);
export const upsertTerm = (...a: Parameters<DecisionsService["upsertTerm"]>) => s().decisions.upsertTerm(...a);
export const deleteTerm = (...a: Parameters<DecisionsService["deleteTerm"]>) => s().decisions.deleteTerm(...a);

// freshness, landing and drafts
export const reportChanges = (...a: Parameters<FreshnessService["reportChanges"]>) => s().freshness.reportChanges(...a);
export const listStale = (...a: Parameters<FreshnessService["listStale"]>) => s().freshness.listStale(...a);
export const markFresh = (...a: Parameters<FreshnessService["markFresh"]>) => s().freshness.markFresh(...a);
export const listStaleDocs = (...a: Parameters<FreshnessService["listStaleDocs"]>) => s().freshness.listStaleDocs(...a);
export const land = (...a: Parameters<FreshnessService["land"]>) => s().freshness.land(...a);
export const resolveDraft = (...a: Parameters<FreshnessService["resolveDraft"]>) => s().freshness.resolveDraft(...a);
export const resolveDocDraft = (...a: Parameters<FreshnessService["resolveDocDraft"]>) => s().freshness.resolveDocDraft(...a);

// sessions
export const sessionSync = (...a: Parameters<SessionsService["sessionSync"]>) => s().sessions.sessionSync(...a);
export const sessionEnd = (...a: Parameters<SessionsService["sessionEnd"]>) => s().sessions.sessionEnd(...a);
export const sessionStatus = (...a: Parameters<SessionsService["sessionStatus"]>) => s().sessions.sessionStatus(...a);
export const noteIssueActivity = (...a: Parameters<SessionsService["noteIssueActivity"]>) => s().sessions.noteIssueActivity(...a);
export const maybeDraftDoc = (...a: Parameters<SessionsService["maybeDraftDoc"]>) => s().sessions.maybeDraftDoc(...a);
export const listDrafts = (...a: Parameters<SessionsService["listDrafts"]>) => s().sessions.listDrafts(...a);
export const listDocDrafts = (...a: Parameters<SessionsService["listDocDrafts"]>) => s().sessions.listDocDrafts(...a);

// Ask
export const askMap = (...a: Parameters<AskService["askMap"]>) => s().ask.askMap(...a);
