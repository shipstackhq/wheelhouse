import { Module } from "@nestjs/common";
import { HealthController } from "./health.controller";

/** The liveness and database check. In every role, so the compose healthcheck works for a process that only serves machines too. */
@Module({ controllers: [HealthController] })
export class HealthModule {}
