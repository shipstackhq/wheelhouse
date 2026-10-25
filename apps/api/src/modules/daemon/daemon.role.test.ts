/** The daemon role loads the machine side of the daemon module and no other domain module. */
process.env.PGLITE_DIR = "memory://";
delete process.env.DATABASE_URL;

import "reflect-metadata";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { buildAppImports } from "../../app.imports";
import { IssuesService } from "../issues/index";
import { RepositoriesService } from "../github/index";
import { NotificationsService } from "../notifications/index";
import { TeamAccessService } from "../teams/index";
import { SessionsService } from "../auth/index";
import { DaemonSweep } from "./daemon.sweep";
import { DeviceAuthService } from "./device-auth.service";
import { DeviceJobsService } from "./device-jobs.service";
import { DeviceStreamService } from "./device-stream.service";
import { DevicesService } from "./devices.service";
import { DeviceGuard } from "./device.guard";

@Module({ imports: buildAppImports("daemon") })
class DaemonRoleApp {}

test("SERVICE_ROLE=daemon starts, resolves the machine side, and loads no other domain module", async () => {
  const app = await NestFactory.createApplicationContext(DaemonRoleApp, { logger: false, abortOnError: false });
  try {
    for (const token of [DeviceAuthService, DeviceStreamService, DeviceJobsService, DeviceGuard, DaemonSweep]) assert.ok(app.get(token), token.name);
    // The inbox is a leaf every role loads: finishing a run tells the person who started it.
    assert.ok(app.get(NotificationsService, { strict: false }));
    for (const token of [TeamAccessService, IssuesService, RepositoriesService, SessionsService, DevicesService]) assert.throws(() => app.get(token, { strict: false }), token.name);
  } finally {
    await app.close();
  }
});
