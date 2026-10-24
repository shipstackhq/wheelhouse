import { Module } from "@nestjs/common";
import { ActorGuard } from "./auth/actor.guard";
import { HumanGuard } from "./auth/human.guard";
import { McpController } from "./mcp/mcp.controller";
import { StreamsModule } from "./platform/streams/streams.module";
import { StreamController } from "./stream/stream.controller";
import { V1Controller } from "./v1/v1.controller";
import { AdminController } from "./web/admin.controller";
import { AuthController } from "./web/auth.controller";
import { DashboardController } from "./web/dashboard.controller";
import { CsrfGuard, SessionGuard } from "./web/endpoints";
import { ImagesController } from "./web/images.controller";
import { InvitesController } from "./web/invites.controller";
import { KeysController } from "./web/keys.controller";
import { MeController } from "./web/me.controller";
import { WorkspaceController } from "./web/workspace.controller";

/**
 * Every controller that has not moved into its own module yet (docs/nest-architecture.md: strangler). They are the "api" role's
 * part of the app, so one switch (SERVICE_ROLE) turns the whole group off in a process that only serves machines. As an area gets
 * its own module under modules/, its controllers leave this list.
 */
@Module({
  imports: [StreamsModule],
  controllers: [McpController, V1Controller, StreamController, AuthController, MeController, ImagesController, AdminController, DashboardController, InvitesController, KeysController, WorkspaceController],
  providers: [ActorGuard, HumanGuard, CsrfGuard, SessionGuard],
})
export class LegacyApiModule {}
