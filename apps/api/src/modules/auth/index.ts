// The auth module's public surface: the only file another module may import. The Nest module class is not exported here, so a plain helper's importer never loads this module's controllers; app.imports.ts imports it from auth.module (docs/nest-architecture.md).
export { AuthService } from "./auth.service";
export type { Human } from "./auth-core";
