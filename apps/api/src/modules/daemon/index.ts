// The daemon module's public surface: the only file another module may import. The Nest module class is not exported here, so a plain helper's importer never loads this module's controllers; app.imports.ts imports it from daemon.module (docs/nest-architecture.md).
export { DaemonService } from "./daemon.service";
