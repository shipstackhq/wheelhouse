import { Module } from "@nestjs/common";
import { NotificationsRepository } from "./notifications.repository";
import { NotificationsService } from "./notifications.service";
import { InboxSignal } from "./notifications.signal";

/**
 * The inbox without its routes: the service producers inject. Every role loads it (the people's modules and the daemon's job
 * finish both notify). A leaf: it imports no other domain module. The routes are in NotificationsModule, the api role only.
 */
@Module({
  providers: [NotificationsRepository, NotificationsService, InboxSignal],
  exports: [NotificationsService],
})
export class NotificationsCoreModule {}
