import { Module } from "@nestjs/common";
import { UserDirectoryModule } from "../auth/user-directory.module";
import { NotificationsCoreModule } from "../notifications/index";
import { BroadcastsRepository } from "./broadcasts.repository";
import { BroadcastsService } from "./broadcasts.service";

/** Sending one message to many people: a service for other code to call. No routes yet; who may send, and how, is decided where it is called from. */
@Module({
  imports: [NotificationsCoreModule, UserDirectoryModule],
  providers: [BroadcastsRepository, BroadcastsService],
  exports: [BroadcastsService],
})
export class BroadcastsModule {}
