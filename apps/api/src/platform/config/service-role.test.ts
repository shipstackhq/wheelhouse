import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readServiceRole, servesApi, servesDaemon } from "./service-role";

describe("SERVICE_ROLE", () => {
  test("unset or blank is all; the three roles are accepted", () => {
    assert.equal(readServiceRole({}), "all");
    assert.equal(readServiceRole({ SERVICE_ROLE: "  " }), "all");
    for (const r of ["api", "daemon", "all"] as const) assert.equal(readServiceRole({ SERVICE_ROLE: r }), r);
  });

  test("anything else is refused at boot", () => {
    assert.throws(() => readServiceRole({ SERVICE_ROLE: "socket" }), /must be one of api, daemon, all/);
  });

  test("which parts each role serves", () => {
    assert.deepEqual([servesApi("api"), servesDaemon("api")], [true, false]);
    assert.deepEqual([servesApi("daemon"), servesDaemon("daemon")], [false, true]);
    assert.deepEqual([servesApi("all"), servesDaemon("all")], [true, true]);
  });
});
