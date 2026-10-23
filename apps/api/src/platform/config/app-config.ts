import { Injectable } from "@nestjs/common";
import { REPO_ROOT } from "../../config";
import { readServiceRole, type ServiceRole } from "./service-role";

/**
 * The environment the API runs with, as config.ts sets it up. Each getter reads process.env when it is used, not when the
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

  /** PGLITE_DIR: where the embedded database is kept (config.ts sets a default when there is no DATABASE_URL). */
  get pgliteDir(): string | undefined {
    return process.env.PGLITE_DIR;
  }

  /** WHEELHOUSE_MIGRATIONS_DIR: the folder of migration files (config.ts sets a default). */
  get migrationsDir(): string | undefined {
    return process.env.WHEELHOUSE_MIGRATIONS_DIR;
  }

  /** SERVICE_ROLE: which part of the API this process serves (see service-role.ts); "all" when unset. */
  get serviceRole(): ServiceRole {
    return readServiceRole(process.env);
  }
}
