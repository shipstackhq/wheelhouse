// The auth module's public surface: the only file another module may import. The Nest module class is not exported here, so a plain helper's importer never loads this module's controllers; app.imports.ts imports it from auth.module (docs/nest-architecture.md).
// The sign-in service and the type callers need are exported; the plain functions are shims for the request guards and the stream (auth.legacy.ts), which go when they move.
export { SessionsService, type Human } from "./sessions.service";
export { actorFromCredentials, humanFromSession } from "./auth.legacy";
