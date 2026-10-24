import type { DocsService } from "./docs.service";

/**
 * Temporary. Code that is not converted yet (the MCP tools through lib/service.ts, the map module, tests) still calls plain functions;
 * these are those functions, each one line forwarding to the live service. `DocsModule.onModuleInit` points them at the service Nest
 * built, so nothing works before the application has booted (tests call `testApp()`). Delete this file when the last caller moves to
 * the service (the MCP redesign moves the tools).
 */
let live: DocsService | undefined;

export function bindDocsLegacy(docs: DocsService) {
  live = docs;
}
const s = (): DocsService => live ?? (() => { throw new Error("The docs module is not booted: start the Nest application (tests: await testApp()) before calling the legacy functions"); })();

export const createDoc = (...a: Parameters<DocsService["createDoc"]>) => s().createDoc(...a);
export const getDoc = (...a: Parameters<DocsService["getDoc"]>) => s().getDoc(...a);
export const listDocs = (...a: Parameters<DocsService["listDocs"]>) => s().listDocs(...a);
export const updateDoc = (...a: Parameters<DocsService["updateDoc"]>) => s().updateDoc(...a);
export const markDocFresh = (...a: Parameters<DocsService["markDocFresh"]>) => s().markDocFresh(...a);
export const moveDoc = (...a: Parameters<DocsService["moveDoc"]>) => s().moveDoc(...a);
export const deleteDoc = (...a: Parameters<DocsService["deleteDoc"]>) => s().deleteDoc(...a);
export const linkDocNode = (...a: Parameters<DocsService["linkDocNode"]>) => s().linkDocNode(...a);
export const searchDocs = (...a: Parameters<DocsService["searchDocs"]>) => s().searchDocs(...a);
export const suggestDocAnchors = (...a: Parameters<DocsService["suggestDocAnchors"]>) => s().suggestDocAnchors(...a);
export const listDocTemplates = (...a: Parameters<DocsService["listDocTemplates"]>) => s().listDocTemplates(...a);
export const listDocsIndex = (...a: Parameters<DocsService["listDocsIndex"]>) => s().listDocsIndex(...a);
