import { Module } from "@nestjs/common";
import { NotificationsController } from "./notifications.controller";
import { NotificationsPurge } from "./notifications.purge";
import { NotificationsCoreModule } from "./notifications.core.module";

/** The signed-in person's own inbox routes and the trash purge (the api role). The service producers call is in NotificationsCoreModule, which every role loads. */
@Module({
  imports: [NotificationsCoreModule],
  controllers: [NotificationsController],
  providers: [NotificationsPurge], // here, not in the core module: only the api role loads it, so one process runs the purge
})
export class NotificationsModule {}
