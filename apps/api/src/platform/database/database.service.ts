import { Injectable, Logger, type OnApplicationShutdown, type OnModuleInit } from "@nestjs/common";
import { closeDb, getDb, type DB } from "../../db";

/** Opens the database and runs the migrations before the server listens, and closes it on shutdown so PGlite flushes. */
@Injectable()
export class DatabaseService implements OnModuleInit, OnApplicationShutdown {
  private readonly log = new Logger("Database");

  /** The Drizzle client once migrations have run. Modules receive it through the DATABASE token, which resolves to this. */
  client(): Promise<DB> {
    return getDb();
  }

  async onModuleInit() {
    await getDb();
    this.log.log("Migrations applied, database ready");
  }

  async onApplicationShutdown(signal?: string) {
    await closeDb();
    this.log.log(`Database closed${signal ? ` (${signal})` : ""}`);
  }
}
