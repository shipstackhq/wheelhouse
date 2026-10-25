import { Inject, Injectable } from "@nestjs/common";
import { isUuid } from "../../common/uuid";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { ServiceError } from "../../common/service-error";
import {
  listNotificationsQuery,
  notificationCountQuery,
  notificationInput,
  type ListNotificationsInput,
  type NotificationCountInput,
  type NotificationInput,
} from "./dto/notifications.dto";
import { InboxSignal } from "./notifications.signal";
import { NotificationsRepository, type NotificationRow, type Recipient } from "./notifications.repository";

/** How long a deleted item stays in the trash before the purge removes it. */
export const PURGE_AFTER_DAYS = 30;
const DAY_MS = 86_400_000;

/**
 * The inbox: producers call `notify`, the recipient reads and marks their own items. Every read and change takes the recipient
 * (a person in a workspace), so one person can never reach another's items; an id that is not theirs is `not_found`. Each change that
 * the person can see sends them the inbox signal, which names no item.
 */
@Injectable()
export class NotificationsService {
  constructor(
    @Inject(NotificationsRepository) private readonly repo: NotificationsRepository,
    @Inject(InboxSignal) private readonly signal: InboxSignal,
  ) {}

  /** Creates the item, or returns null when the recipient already has one with this `dedupeKey` (no signal then: nothing changed). */
  async notify(input: NotificationInput): Promise<NotificationRow | null> {
    const value = new ZodValidationPipe(notificationInput).transform(input);
    const row = await this.repo.insertIfNew(value);
    if (!row) return null;
    this.signal.changed({ userId: row.recipientUserId, workspaceId: row.workspaceId }, row.teamId);
    return row;
  }

  /**
   * Creates many items at once (a broadcast's batch) and returns how many were new; a recipient that already has one with the same
   * dedupe key is skipped. One insert, then one signal per new item.
   */
  async notifyMany(inputs: NotificationInput[]): Promise<number> {
    const pipe = new ZodValidationPipe(notificationInput);
    const rows = await this.repo.insertManyIfNew(inputs.map((i) => pipe.transform(i)));
    for (const row of rows) this.signal.changed({ userId: row.recipientUserId, workspaceId: row.workspaceId }, row.teamId);
    return rows.length;
  }

  async list(who: Recipient, query: ListNotificationsInput = {}) {
    const q = new ZodValidationPipe(listNotificationsQuery).transform(query);
    const rows = await this.repo.listPage(who, {
      view: q.view,
      cursor: q.cursor ?? null,
      limit: q.limit + 1,
      unreadOnly: q.unreadOnly,
      teamId: q.teamId ?? undefined,
    });
    const hasMore = rows.length > q.limit;
    const items = hasMore ? rows.slice(0, q.limit) : rows;
    return { items, nextCursor: hasMore ? items[items.length - 1].id : null };
  }

  async unreadCount(who: Recipient, query: NotificationCountInput = {}): Promise<number> {
    const q = new ZodValidationPipe(notificationCountQuery).transform(query);
    return this.repo.countUnread(who, q.teamId ?? undefined);
  }

  async markRead(who: Recipient, id: string): Promise<NotificationRow> {
    const row = this.found(isUuid(id) ? await this.repo.markRead(who, id) : undefined);
    this.signal.changed(who, row.teamId);
    return row;
  }

  async markAllRead(who: Recipient): Promise<number> {
    const changed = await this.repo.markAllRead(who);
    this.signal.changed(who, null);
    return changed;
  }

  async archive(who: Recipient, id: string): Promise<NotificationRow> {
    const row = this.found(isUuid(id) ? await this.repo.archive(who, id) : undefined);
    this.signal.changed(who, row.teamId);
    return row;
  }

  async unarchive(who: Recipient, id: string): Promise<NotificationRow> {
    return this.changed(who, isUuid(id) ? await this.repo.unarchive(who, id) : undefined);
  }

  /** Moves the item to the trash (idempotent). The purge removes it for good PURGE_AFTER_DAYS later. */
  async delete(who: Recipient, id: string): Promise<NotificationRow> {
    return this.changed(who, isUuid(id) ? await this.repo.softDelete(who, id) : undefined);
  }

  async restore(who: Recipient, id: string): Promise<NotificationRow> {
    return this.changed(who, isUuid(id) ? await this.repo.restore(who, id) : undefined);
  }

  /** Removes the items deleted more than `days` before `now` (both injectable for tests). Returns how many. */
  async purge(now: Date = new Date(), days: number = PURGE_AFTER_DAYS): Promise<number> {
    return this.repo.purgeDeletedBefore(new Date(now.getTime() - days * DAY_MS));
  }

  private changed(who: Recipient, row: NotificationRow | undefined): NotificationRow {
    const found = this.found(row);
    this.signal.changed(who, found.teamId);
    return found;
  }

  private found(row: NotificationRow | undefined): NotificationRow {
    if (!row) throw new ServiceError("not_found", "Notification not found");
    return row;
  }
}
