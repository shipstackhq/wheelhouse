/**
 * The database schema, one file per owning module (docs/nest-architecture.md): the tables of an area live in tables/<area>.ts.
 * Foreign keys cross areas, so the files import each other; the tables are one database-level contract. This file only re-exports
 * them, so `import * as schema from "./schema"` and the drizzle config see every table as before.
 */
export * from "./tables/auth";
export * from "./tables/teams";
export * from "./tables/issues";
export * from "./tables/map";
export * from "./tables/docs";
export * from "./tables/github";
export * from "./tables/daemon";
export * from "./tables/events";
export * from "./tables/broadcasts";
export * from "./tables/notifications";
export * from "./tables/agents";
