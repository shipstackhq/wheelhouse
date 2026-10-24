// The docs module's public surface: the only file another module may import. The Nest module class is not exported here, so a plain helper's importer never loads this module's controllers; app.imports.ts imports it from docs.module (docs/nest-architecture.md).
// The service is what converted modules inject; the plain functions are shims for the callers not converted yet (docs.legacy.ts) and go when the last one moves.
export { DocsService, type DocInput, type DocUpdateInput } from "./docs.service";
export type { DocRow } from "./docs.repository";
export { listDocsIndex, updateDoc } from "./docs.legacy";
