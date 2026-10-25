import type { DocFreshnessService } from "./doc-freshness.service";
import type { DocsService } from "./docs.service";

/**
 * Temporary. Code that is not converted yet (the MCP tools through lib/service.ts, the map module, tests) still calls plain functions;
 * these are those functions, each one line forwarding to the live service. `DocsModule.onModuleInit` points them at the service Nest
 * built, so nothing works before the application has booted (tests call `testApp()`). Delete this file when the last caller moves to
 * the service (the MCP redesign moves the tools).
 */
type Live = { docs: DocsService; freshness: DocFreshnessService };
let live: Live | undefined;

export function bindDocsLegacy(docs: DocsService, freshness: DocFreshnessService) {
  live = { docs, freshness };
}
const s = (): Live => live ?? (() => { throw new Error("The docs module is not booted: start the Nest application (tests: await testApp()) before calling the legacy functions"); })();

export const createDoc = (...a: Parameters<DocsService["createDoc"]>) => s().docs.createDoc(...a);
export const getDoc = (...a: Parameters<DocsService["getDoc"]>) => s().docs.getDoc(...a);
export const listDocs = (...a: Parameters<DocsService["listDocs"]>) => s().docs.listDocs(...a);
export const updateDoc = (...a: Parameters<DocsService["updateDoc"]>) => s().docs.updateDoc(...a);
export const markDocFresh = (...a: Parameters<DocsService["markDocFresh"]>) => s().docs.markDocFresh(...a);
export const moveDoc = (...a: Parameters<DocsService["moveDoc"]>) => s().docs.moveDoc(...a);
export const deleteDoc = (...a: Parameters<DocsService["deleteDoc"]>) => s().docs.deleteDoc(...a);
export const linkDocNode = (...a: Parameters<DocsService["linkDocNode"]>) => s().docs.linkDocNode(...a);
export const searchDocs = (...a: Parameters<DocsService["searchDocs"]>) => s().docs.searchDocs(...a);
export const suggestDocAnchors = (...a: Parameters<DocsService["suggestDocAnchors"]>) => s().docs.suggestDocAnchors(...a);
export const listDocTemplates = (...a: Parameters<DocsService["listDocTemplates"]>) => s().docs.listDocTemplates(...a);
export const listDocsIndex = (...a: Parameters<DocsService["listDocsIndex"]>) => s().docs.listDocsIndex(...a);

// freshness and drafts
export const listStaleDocs = (...a: Parameters<DocFreshnessService["listStaleDocs"]>) => s().freshness.listStaleDocs(...a);
export const listDocDrafts = (...a: Parameters<DocFreshnessService["listDocDrafts"]>) => s().freshness.listDocDrafts(...a);
export const resolveDocDraft = (...a: Parameters<DocFreshnessService["resolveDocDraft"]>) => s().freshness.resolveDocDraft(...a);
