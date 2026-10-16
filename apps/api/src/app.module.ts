import { Module } from "@nestjs/common";
import { ActorGuard } from "./auth/actor.guard";
import { DatabaseService } from "./database/database.service";
import { HealthController } from "./health/health.controller";
import { McpController } from "./mcp/mcp.controller";
import { V1Controller } from "./v1/v1.controller";

@Module({
  controllers: [HealthController, McpController, V1Controller],
  providers: [DatabaseService, ActorGuard],
})
export class AppModule {}
