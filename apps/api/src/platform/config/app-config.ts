import { Injectable, Logger } from "@nestjs/common";
import { KEY_SCOPES, type KeyScope } from "@wheelhouse/shared/key-scopes";
import { REPO_ROOT } from "./environment";
import { readServiceRole, type ServiceRole } from "./service-role";

/**
 * The environment the API runs with, as environment.ts sets it up. Each getter reads process.env when it is used, not when the
 * service is created, so it always answers what the server's libraries read: undefined means "not set".
 */
@Injectable()
export class AppConfig {
  /** The repository root (where .env and the packages live). */
  get repoRoot(): string {
    return REPO_ROOT;
  }

  /** DATABASE_URL: set means Postgres, unset means the embedded PGlite database. */
  get databaseUrl(): string | undefined {
    return process.env.DATABASE_URL;
  }

  /** PGLITE_DIR: where the embedded database is kept (environment.ts sets a default when there is no DATABASE_URL). */
  get pgliteDir(): string | undefined {
    return process.env.PGLITE_DIR;
  }

  /** WHEELHOUSE_MIGRATIONS_DIR: the folder of migration files (environment.ts sets a default). */
  get migrationsDir(): string | undefined {
    return process.env.WHEELHOUSE_MIGRATIONS_DIR;
  }

  /** SERVICE_ROLE: which part of the API this process serves (see service-role.ts); "all" when unset. */
  get serviceRole(): ServiceRole {
    return readServiceRole(process.env);
  }

  /**
   * CHAT_SCOPES: what a chat answer's key may do, comma-separated. `read` is always held; unknown names are dropped with a warning;
   * `planning:write` is never granted to chat.
   */
  get chatScopes(): KeyScope[] {
    const asked = (process.env.CHAT_SCOPES ?? "read,board:write,map:write,docs:write").split(",").map((x) => x.trim()).filter(Boolean);
    const known = asked.filter((x): x is KeyScope => (KEY_SCOPES as readonly string[]).includes(x));
    const unknown = asked.filter((x) => !(KEY_SCOPES as readonly string[]).includes(x));
    if (unknown.length) new Logger("AppConfig").warn(`CHAT_SCOPES: ignoring unknown ${unknown.join(", ")}`);
    return ["read", ...new Set(known.filter((x) => x !== "read" && x !== "planning:write"))];
  }
}
