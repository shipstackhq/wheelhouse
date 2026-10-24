import { AsyncLocalStorage } from "node:async_hooks";
import { Inject, Injectable } from "@nestjs/common";
import type { DB } from "../../db";
import { DATABASE } from "./database.token";
import type { Q } from "./transaction";

/**
 * The one way a module reaches the database. `q` is the current transaction when the call is inside `transaction(...)`, otherwise the
 * client, so no `tx` is passed through signatures and a repository just reads `this.db.q`. The transaction travels in AsyncLocalStorage.
 * The client is the one src/db/index.ts wraps with `publishAfterCommit`, so an event emitted inside a transaction publishes after the commit.
 */
@Injectable()
export class Database {
  private readonly current = new AsyncLocalStorage<Q>();

  constructor(@Inject(DATABASE) private readonly client: DB) {}

  /** The current transaction, or the client outside one. Read it at the moment of the query, never keep it. */
  get q(): Q {
    return this.current.getStore() ?? this.client;
  }

  /** Runs `fn` in a transaction. Inside one already, `fn` joins it (no nested transaction, no savepoint); an error rolls back the outermost. */
  transaction<T>(fn: () => Promise<T>): Promise<T> {
    const outer = this.current.getStore();
    if (outer && outer !== this.client) return fn();
    return this.client.transaction((tx) => this.current.run(tx, fn));
  }

  /**
   * Runs `fn` with `q` as the current handle. For the shims of modules not converted yet: their callers run `db.transaction(tx => ...)`
   * themselves and pass `tx` in, and what the converted code does next (row locks, writes) has to happen on that transaction.
   */
  within<T>(q: Q, fn: () => Promise<T>): Promise<T> {
    return this.current.run(q, fn);
  }
}
