import { Inject, Injectable } from "@nestjs/common";
import { eq, sql } from "drizzle-orm";
import { schema } from "../../db";
import { Database } from "../../platform/database/database";
import type { ParsedBroadcastInput } from "./dto/broadcasts.dto";

const { broadcasts } = schema;

export type BroadcastRow = typeof broadcasts.$inferSelect;

/** Every query on the broadcasts table, and the only file in the module that touches Drizzle. */
@Injectable()
export class BroadcastsRepository {
  constructor(@Inject(Database) private readonly db: Database) {}

  /** The broadcast with this key, created (pending) when there is none yet. Two senders racing on one key get the same row. */
  async findOrCreate(input: ParsedBroadcastInput): Promise<BroadcastRow> {
    const { key, source, type, title, body, bodyFormat, href, actorName, audience } = input;
    await this.db.q
      .insert(broadcasts)
      .values({ key, source, type, title, body, bodyFormat, href: href ?? null, actorName, audience })
      .onConflictDoNothing({ target: broadcasts.key });
    const [row] = await this.db.q.select().from(broadcasts).where(eq(broadcasts.key, key));
    return row;
  }

  async get(id: string): Promise<BroadcastRow | undefined> {
    const [row] = await this.db.q.select().from(broadcasts).where(eq(broadcasts.id, id));
    return row;
  }

  async markSending(id: string): Promise<void> {
    await this.db.q.update(broadcasts).set({ status: "sending", error: null }).where(eq(broadcasts.id, id));
  }

  /** Counts in SQL, so two senders resuming one broadcast do not overwrite each other's progress. */
  async addDelivered(id: string, n: number): Promise<void> {
    if (n > 0) await this.db.q.update(broadcasts).set({ delivered: sql`${broadcasts.delivered} + ${n}` }).where(eq(broadcasts.id, id));
  }

  async markDone(id: string): Promise<void> {
    await this.db.q.update(broadcasts).set({ status: "done", completedAt: sql`now()`, error: null }).where(eq(broadcasts.id, id));
  }

  async markFailed(id: string, error: string): Promise<void> {
    await this.db.q.update(broadcasts).set({ status: "failed", error: error.slice(0, 1000) }).where(eq(broadcasts.id, id));
  }
}
