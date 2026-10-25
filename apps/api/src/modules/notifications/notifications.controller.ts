import { Controller, Delete, Get, HttpCode, Inject, Param, Post, Query, Req } from "@nestjs/common";
import { AppEndpoints } from "../../common/decorators/app-endpoints.decorator";
import { type SessionRequest } from "../../common/guards/session.guard";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { listNotificationsQuery, notificationCountQuery, type ListNotificationsQuery, type NotificationCountQuery } from "./dto/notifications.dto";
import { notificationView } from "./notifications.presenter";
import { NotificationsService } from "./notifications.service";
import type { Recipient } from "./notifications.repository";

/** The signed-in person's own inbox. The recipient is always the session's person in the session's workspace; nothing about whose inbox it is comes from the request. */
@Controller("api/app/notifications")
@AppEndpoints()
export class NotificationsController {
  constructor(@Inject(NotificationsService) private readonly inbox: NotificationsService) {}

  /** A page of the inbox, archive (`view=archived`) or trash (`view=trash`, newest deleted first); default inbox. `cursor` is the `nextCursor` of the previous page; `unreadOnly`, `teamId` filter it. */
  @Get()
  async list(@Req() req: SessionRequest, @Query(new ZodValidationPipe(listNotificationsQuery)) query: ListNotificationsQuery) {
    const page = await this.inbox.list(recipientOf(req), query);
    return { items: page.items.map(notificationView), nextCursor: page.nextCursor };
  }

  /** The number of unread items, all of them or one team's (`teamId`). */
  @Get("unread-count")
  async unreadCount(@Req() req: SessionRequest, @Query(new ZodValidationPipe(notificationCountQuery)) query: NotificationCountQuery) {
    return { count: await this.inbox.unreadCount(recipientOf(req), query) };
  }

  /** Marks every unread item of the inbox read. */
  @Post("read-all")
  @HttpCode(200)
  async readAll(@Req() req: SessionRequest) {
    return { updated: await this.inbox.markAllRead(recipientOf(req)) };
  }

  /** Marks one item read. Another person's item is a 404. */
  @Post(":id/read")
  @HttpCode(200)
  async read(@Req() req: SessionRequest, @Param("id") id: string) {
    return { notification: notificationView(await this.inbox.markRead(recipientOf(req), id)) };
  }

  /** Takes one item out of the inbox. Another person's item is a 404. */
  @Post(":id/archive")
  @HttpCode(200)
  async archive(@Req() req: SessionRequest, @Param("id") id: string) {
    return { notification: notificationView(await this.inbox.archive(recipientOf(req), id)) };
  }

  /** Puts an archived item back in the inbox. Another person's item, or a deleted one, is a 404. */
  @Post(":id/unarchive")
  @HttpCode(200)
  async unarchive(@Req() req: SessionRequest, @Param("id") id: string) {
    return { notification: notificationView(await this.inbox.unarchive(recipientOf(req), id)) };
  }

  /** Moves one item to the trash (it is removed for good after 30 days). Another person's item is a 404. */
  @Delete(":id")
  @HttpCode(200)
  async remove(@Req() req: SessionRequest, @Param("id") id: string) {
    return { notification: notificationView(await this.inbox.delete(recipientOf(req), id)) };
  }

  /** Takes a deleted item out of the trash. Another person's item, or one that is not deleted, is a 404. */
  @Post(":id/restore")
  @HttpCode(200)
  async restore(@Req() req: SessionRequest, @Param("id") id: string) {
    return { notification: notificationView(await this.inbox.restore(recipientOf(req), id)) };
  }
}

const recipientOf = (req: SessionRequest): Recipient => ({ userId: req.human.user.id, workspaceId: req.human.actor.workspaceId });
