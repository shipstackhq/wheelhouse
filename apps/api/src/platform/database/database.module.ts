import { Global, Module } from "@nestjs/common";
import type { DB } from "@wheelhouse/core/db";
import { DatabaseService } from "./database.service";

/**
 * The Drizzle client, injected: `@Inject(DATABASE) db: DB`. It is the one instance core hands out after the migrations have run,
 * so it is the same object everywhere, and Nest waits for it before the app starts listening.
 */
export const DATABASE = Symbol("DATABASE");

@Global()
@Module({
  providers: [
    DatabaseService,
    { provide: DATABASE, inject: [DatabaseService], useFactory: (service: DatabaseService): Promise<DB> => service.client() },
  ],
  exports: [DATABASE, DatabaseService],
})
export class DatabaseModule {}
