import { Injectable, Logger, type OnApplicationShutdown, type OnModuleInit } from "@nestjs/common";
import { closeDb, getDb } from "@wheelhouse/core/db";

/** Opens the database and runs the migrations before the server listens, and closes it on shutdown so PGlite flushes. */
@Injectable()
export class DatabaseService implements OnModuleInit, OnApplicationShutdown {
  private readonly log = new Logger("Database");

  async onModuleInit() {
    await getDb();
    this.log.log("Migrations applied, database ready");
  }

  async onApplicationShutdown(signal?: string) {
    await closeDb();
    this.log.log(`Database closed${signal ? ` (${signal})` : ""}`);
  }
}
