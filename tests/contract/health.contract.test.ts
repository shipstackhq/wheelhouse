import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { call } from "./lib/http";

describe("GET /api/health", () => {
  test("answers 200 {ok:true} with no credentials", async () => {
    const r = await call("/api/health");
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { ok: true });
  });
});
