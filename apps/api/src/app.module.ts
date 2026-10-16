import { Module } from "@nestjs/common";
import { ActorGuard } from "./auth/actor.guard";
import { DatabaseService } from "./database/database.service";
import { HumanGuard } from "./auth/human.guard";
import { GithubController } from "./github/github.controller";
import { WebhookController } from "./github/webhook.controller";
import { HealthController } from "./health/health.controller";
import { McpController } from "./mcp/mcp.controller";
import { StreamController } from "./stream/stream.controller";
import { StreamRegistry } from "./stream/stream.registry";
import { V1Controller } from "./v1/v1.controller";

@Module({
  controllers: [HealthController, McpController, V1Controller, WebhookController, GithubController, StreamController],
  providers: [DatabaseService, ActorGuard, HumanGuard, StreamRegistry],
})
export class AppModule {}
