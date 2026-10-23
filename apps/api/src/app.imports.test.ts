import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { DynamicModule } from "@nestjs/common";
import { LegacyApiModule } from "./legacy-api.module";
import { buildAppImports } from "./app.imports";
import { DaemonController } from "./modules/daemon/daemon.controller";
import { DaemonSweep } from "./modules/daemon/daemon.sweep";
import { daemonControllers, daemonProviders, DaemonModule } from "./modules/daemon/daemon.module";
import { DevicesController } from "./modules/daemon/devices.controller";

const names = (xs: unknown[]) => xs.map((x) => (x as { name: string }).name);

describe("what each SERVICE_ROLE loads", () => {
  test("all (the default) loads everything: the legacy group and both sides of the daemon module", () => {
    const imports = buildAppImports("all");
    assert.ok(imports.includes(LegacyApiModule));
    assert.deepEqual(names(daemonControllers("all")), ["DaemonController", "DevicesController"]);
    assert.ok(daemonProviders("all").includes(DaemonSweep));
  });

  test("api serves people: the legacy group and the devices routes, but not the machine API or the sweep", () => {
    assert.ok(buildAppImports("api").includes(LegacyApiModule));
    assert.deepEqual(daemonControllers("api"), [DevicesController]);
    assert.ok(!daemonProviders("api").includes(DaemonSweep));
  });

  test("daemon serves machines: only the machine API and the sweep, none of the legacy group", () => {
    assert.ok(!buildAppImports("daemon").includes(LegacyApiModule));
    assert.deepEqual(daemonControllers("daemon"), [DaemonController]);
    assert.ok(daemonProviders("daemon").includes(DaemonSweep));
  });

  test("the platform modules and the daemon module are in every role, and the legacy group comes before the daemon module", () => {
    for (const role of ["api", "daemon", "all"] as const) {
      const imports = buildAppImports(role);
      assert.ok(imports.some((m) => (m as DynamicModule).module === DaemonModule), role);
      assert.deepEqual(names(imports.slice(0, 3)), ["ConfigModule", "DatabaseModule", "EventsModule"], role);
    }
    const all = buildAppImports("all");
    assert.ok(all.indexOf(LegacyApiModule) < all.findIndex((m) => (m as DynamicModule).module === DaemonModule));
  });
});
