import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, isNotNull, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import { schema } from "../../db";
import { Database } from "../../platform/database/database";

const { notifications } = schema;

export type NotificationRow = typeof notifications.$inferSelect;
export type NotificationInsert = typeof notifications.$inferInsert;

export type NotificationView = "inbox" | "archived" | "trash";

/** Whose items a read or change may touch: one person, in one workspace. The workspace comes from the session, never the request. */
export type Recipient = { userId: string; workspaceId: string };

/**
 * Every query on the notifications table, and the only file in the module that touches Drizzle. Each method is scoped to one
 * recipient in one workspace: a row is only ever read or changed through its owner's id.
 */
@Injectable()
export class NotificationsRepository {
  constructor(@Inject(Database) private readonly db: Database) {}

  /** The row, or undefined when the recipient already has one with the same dedupe key. */
  async insertIfNew(values: NotificationInsert): Promise<NotificationRow | undefined> {
    const [row] = await this.db.q
      .insert(notifications)
      .values(values)
      .onConflictDoNothing({ target: [notifications.recipientUserId, notifications.dedupeKey] })
      .returning();
    return row;
  }

  /** The rows that were new: a recipient that already has an item with the same dedupe key is skipped, not an error. */
  async insertManyIfNew(values: NotificationInsert[]): Promise<NotificationRow[]> {
    if (!values.length) return [];
    return this.db.q
      .insert(notifications)
      .values(values)
      .onConflictDoNothing({ target: [notifications.recipientUserId, notifications.dedupeKey] })
      .returning();
  }

  /**
   * One page of a view: the inbox (not archived, not deleted), the archive (archived, not deleted) or the trash (deleted). The inbox and
   * the archive run newest first by created_at, the trash by deleted_at. The cursor is keyset on (that time, id), so a row changed
   * meanwhile does not shift the page.
   */
  listPage(who: Recipient, opts: { view: NotificationView; cursor: string | null; limit: number; unreadOnly: boolean; teamId?: string }): Promise<NotificationRow[]> {
    const { view, cursor, limit, unreadOnly, teamId } = opts;
    const trash = view === "trash";
    const col = trash ? notifications.deletedAt : notifications.createdAt;
    const colName = trash ? "deleted_at" : "created_at";
    return this.db.q
      .select()
      .from(notifications)
      .where(
        and(
          ownedBy(who),
          view === "inbox" ? isNull(notifications.archivedAt) : view === "archived" ? isNotNull(notifications.archivedAt) : undefined,
          trash ? isNotNull(notifications.deletedAt) : isNull(notifications.deletedAt),
          unreadOnly ? isNull(notifications.readAt) : undefined,
          teamId ? eq(notifications.teamId, teamId) : undefined,
          cursor
            ? sql`(${col}, ${notifications.id}) < (select ${sql.raw(`n.${colName}`)}, n.id from ${notifications} n where n.id = ${cursor} and n.recipient_user_id = ${who.userId} and (n.workspace_id = ${who.workspaceId} or n.workspace_id is null))`
            : undefined,
        ),
      )
      .orderBy(desc(col), desc(notifications.id))
      .limit(limit);
  }

  async countUnread(who: Recipient, teamId?: string): Promise<number> {
    const [r] = await this.db.q
      .select({ n: sql<number>`count(*)::int` })
      .from(notifications)
      .where(and(ownedBy(who), isNull(notifications.readAt), isNull(notifications.archivedAt), isNull(notifications.deletedAt), teamId ? eq(notifications.teamId, teamId) : undefined));
    return Number(r.n);
  }

  /** Marks one of the recipient's items read; the first read time is kept. Undefined when it is not theirs. */
  async markRead(who: Recipient, id: string): Promise<NotificationRow | undefined> {
    const [row] = await this.db.q
      .update(notifications)
      .set({ readAt: sql`coalesce(${notifications.readAt}, now())` })
      .where(and(eq(notifications.id, id), ownedBy(who)))
      .returning();
    return row;
  }

  /** Marks every unread, unarchived, undeleted item of the recipient read. Returns how many changed. */
  async markAllRead(who: Recipient): Promise<number> {
    const rows = await this.db.q
      .update(notifications)
      .set({ readAt: sql`now()` })
      .where(and(ownedBy(who), isNull(notifications.readAt), isNull(notifications.archivedAt), isNull(notifications.deletedAt)))
      .returning({ id: notifications.id });
    return rows.length;
  }

  /** Takes one of the recipient's items out of the inbox. Undefined when it is not theirs or is deleted. */
  async archive(who: Recipient, id: string): Promise<NotificationRow | undefined> {
    return this.change(who, id, { archivedAt: sql`coalesce(${notifications.archivedAt}, now())` }, isNull(notifications.deletedAt));
  }

  /** Puts an archived item back in the inbox. Undefined when it is not theirs or is deleted. */
  async unarchive(who: Recipient, id: string): Promise<NotificationRow | undefined> {
    return this.change(who, id, { archivedAt: null }, isNull(notifications.deletedAt));
  }

  /** Moves an item to the trash; the first delete time is kept. Undefined when it is not theirs. */
  async softDelete(who: Recipient, id: string): Promise<NotificationRow | undefined> {
    return this.change(who, id, { deletedAt: sql`coalesce(${notifications.deletedAt}, now())` });
  }

  /** Takes a deleted item out of the trash, back to the state its archivedAt says. Undefined when it is not theirs or not deleted. */
  async restore(who: Recipient, id: string): Promise<NotificationRow | undefined> {
    return this.change(who, id, { deletedAt: null }, isNotNull(notifications.deletedAt));
  }

  /** Removes every row deleted before `cutoff`, for every recipient. Returns how many. Safe to run twice at once: a row goes once. */
  async purgeDeletedBefore(cutoff: Date): Promise<number> {
    const rows = await this.db.q.delete(notifications).where(lt(notifications.deletedAt, cutoff)).returning({ id: notifications.id });
    return rows.length;
  }

  private async change(who: Recipient, id: string, set: { archivedAt?: SQL | null; deletedAt?: SQL | null }, extra?: SQL): Promise<NotificationRow | undefined> {
    const [row] = await this.db.q
      .update(notifications)
      .set(set)
      .where(and(eq(notifications.id, id), ownedBy(who), extra))
      .returning();
    return row;
  }
}

/** The person's items in this workspace, plus their instance-level ones (no workspace), which show in every workspace of theirs. */
const ownedBy = (who: Recipient) =>
  and(eq(notifications.recipientUserId, who.userId), or(eq(notifications.workspaceId, who.workspaceId), isNull(notifications.workspaceId)));
