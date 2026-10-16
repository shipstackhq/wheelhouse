import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { StreamRegistry } from "./stream.registry";

describe("StreamRegistry", () => {
  test("shutdown ends every open stream, and only those", () => {
    const r = new StreamRegistry();
    const a = new AbortController();
    const b = new AbortController();
    const gone = new AbortController();
    r.track(a);
    r.track(b);
    r.track(gone)(); // closed by its client before shutdown
    assert.equal(r.size, 2);
    r.beforeApplicationShutdown();
    assert.equal(a.signal.aborted, true);
    assert.equal(b.signal.aborted, true);
    assert.equal(gone.signal.aborted, false, "a stream that already ended is left alone");
    assert.equal(r.size, 0);
  });
  test("forgetting a stream twice, or shutting down with none open, is harmless", () => {
    const r = new StreamRegistry();
    const forget = r.track(new AbortController());
    forget();
    forget();
    r.beforeApplicationShutdown();
    assert.equal(r.size, 0);
  });
});
