import { Module } from "@nestjs/common";
import { VerdictRepository } from "./verdict.repository";
import { VerdictService } from "./verdict.service";

/** The verdict service without routes: the daemon's planner and runs and the issues' delegation state inject it. */
@Module({ providers: [VerdictRepository, VerdictService], exports: [VerdictService] })
export class VerdictModule {}
