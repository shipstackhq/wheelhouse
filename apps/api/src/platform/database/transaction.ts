import { eq } from "drizzle-orm";
import { schema, type DB } from "../../db";

export type Tx = Parameters<Parameters<DB["transaction"]>[0]>[0];
export type Q = DB | Tx;

/**
 * Lock a row for the rest of the transaction and read it as it is NOW. A version check that reads, compares and writes is only
 * safe if two edits from the same version cannot both read it before either writes; on Postgres (not on the single-connection
 * embedded database the tests use) they can. The second one waits here for the first to commit, then sees its version.
 */
export async function lockRow<T extends { id: string }>(tx: Tx, table: typeof schema.issues | typeof schema.nodes | typeof schema.docs, row: T): Promise<T> {
  const [fresh] = await tx.select().from(table).where(eq(table.id, row.id)).for("update");
  return (fresh as unknown as T | undefined) ?? row;
}
