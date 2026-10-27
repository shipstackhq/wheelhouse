// The docs module's public surface: the only file another module may import. The Nest module class is not exported here, so a plain helper's importer never loads this module's controllers; app.imports.ts imports it from docs.module (docs/nest-architecture.md).
// The services are what converted modules inject. The plain functions (docs.legacy.ts) are shims for the tests, which import that file directly.
export { DocsService, type DocInput, type DocUpdateInput } from "./docs.service";
export { DocFreshnessService } from "./doc-freshness.service";
export type { DocRow } from "./docs.repository";
