import { Module } from "@nestjs/common";
import { buildAppImports } from "./app.imports";
import { RequestPipelineModule } from "./common/request-pipeline.module";
import { HealthController } from "./health/health.controller";
import { readServiceRole } from "./platform/config/service-role";

// Read when this file is first loaded: main.ts imports it after configureEnvironment(), so .env is already in process.env.
const role = readServiceRole(process.env);

@Module({
  imports: [RequestPipelineModule, ...buildAppImports(role)],
  controllers: [HealthController],
})
export class AppModule {}
