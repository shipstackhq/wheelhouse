import { Inject, Injectable } from "@nestjs/common";
import { asc, gt } from "drizzle-orm";
import { schema } from "../../db";
import { Database } from "../../platform/database/database";

/**
 * Who has an account, for the modules that address people in bulk (a broadcast). The users table stays the auth module's own: others
 * ask here and get ids, in pages ordered by id so a walk over everyone never skips or repeats a person that signs up meanwhile.
 */
@Injectable()
export class UserDirectory {
  constructor(@Inject(Database) private readonly db: Database) {}

  /** Up to `limit` user ids greater than `after` (null: from the start), ascending. */
  async idsAfter(after: string | null, limit: number): Promise<string[]> {
    const rows = await this.db.q
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(after ? gt(schema.users.id, after) : undefined)
      .orderBy(asc(schema.users.id))
      .limit(limit);
    return rows.map((r) => r.id);
  }
}
