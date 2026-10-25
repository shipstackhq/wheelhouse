import { Global, Module } from "@nestjs/common";
import type { DB } from "../../db";
import { Database } from "./database";
import { DATABASE } from "./database.token";
import { DatabaseService } from "./database.service";

export { DATABASE };

/**
 * The Drizzle client, injected: `@Inject(DATABASE) db: DB`. It is the one instance core hands out after the migrations have run,
 * so it is the same object everywhere, and Nest waits for it before the app starts listening.
 */

@Global()
@Module({
  providers: [
    DatabaseService,
    Database,
    { provide: DATABASE, inject: [DatabaseService], useFactory: (service: DatabaseService): Promise<DB> => service.client() },
  ],
  exports: [DATABASE, DatabaseService, Database],
})
export class DatabaseModule {}
