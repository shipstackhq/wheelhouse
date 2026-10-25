import { Module } from "@nestjs/common";
import { EventsService } from "./events.service";

/** Not global: a module that publishes events imports it, which keeps the dependency visible. */
@Module({
  providers: [EventsService],
  exports: [EventsService],
})
export class EventsModule {}
