import { Module } from "@nestjs/common";
import { ActorGuard } from "./common/guards/actor.guard";
import { HumanGuard } from "./common/guards/human.guard";
import { McpController } from "./mcp/mcp.controller";
import { StreamsModule } from "./platform/streams/streams.module";
import { StreamController } from "./stream/stream.controller";
import { V1Controller } from "./v1/v1.controller";
import { CsrfGuard } from "./common/guards/csrf.guard";
import { SessionGuard } from "./common/guards/session.guard";
import { ImagesController } from "./web/images.controller";

/**
 * Every controller that has not moved into its own module yet (docs/nest-architecture.md: strangler). They are the "api" role's
 * part of the app, so one switch (SERVICE_ROLE) turns the whole group off in a process that only serves machines. As an area gets
 * its own module under modules/, its controllers leave this list.
 */
@Module({
  imports: [StreamsModule],
  controllers: [McpController, V1Controller, StreamController, ImagesController],
  providers: [ActorGuard, HumanGuard, CsrfGuard, SessionGuard],
})
export class LegacyApiModule {}
