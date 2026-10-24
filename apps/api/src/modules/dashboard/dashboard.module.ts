import { Module } from "@nestjs/common";
import { DashboardController } from "./dashboard.controller";
import { DashboardService } from "./dashboard.service";

/**
 * The read models that look across areas: the dashboard's widgets (metrics) and a team's setup checklist. Nothing here writes; the
 * person's side only, so it is part of the api role.
 */
@Module({ controllers: [DashboardController], providers: [DashboardService], exports: [DashboardService] })
export class DashboardModule {}
