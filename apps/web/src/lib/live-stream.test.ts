import { describe, test } from "vitest";
import assert from "node:assert/strict";
import { backoffMs, DEBOUNCE_MS, FALLBACK_AFTER, onStreamMessage, shouldFallBack, streamUrl } from "./live-stream";

describe("reconnecting", () => {
  test("waits 1s, 2s, 4s ... and never more than 30s", () => {
    assert.deepEqual([1, 2, 3, 4, 5].map(backoffMs), [1000, 2000, 4000, 8000, 16000]);
    assert.equal(backoffMs(6), 30_000);
    assert.equal(backoffMs(50), 30_000);
    assert.equal(backoffMs(0), 1000, "never zero, never negative");
  });

  test("falls back to polling only after several failures in a row", () => {
    assert.equal(FALLBACK_AFTER, 3);
    assert.deepEqual([1, 2, 3, 4].map(shouldFallBack), [false, false, true, true]);
  });

  test("resumes from where it left off, or starts clean", () => {
    assert.equal(streamUrl("/api/projects/WH/stream", null), "/api/projects/WH/stream");
    assert.equal(streamUrl("/api/projects/WH/stream", 120), "/api/projects/WH/stream?since=120");
    assert.equal(streamUrl("/api/stream", 0), "/api/stream?since=0", "position 0 is a position");
  });

  test("bursts are folded together over a short window", () => {
    assert.ok(DEBOUNCE_MS >= 100 && DEBOUNCE_MS <= 500);
  });
});

describe("what a stream message means for the page", () => {
  test("the first ready only records where the log is: nothing to refresh yet", () => {
    assert.deepEqual(onStreamMessage(null, { kind: "ready", seq: 500 }), { last: 500, refresh: false });
  });

  test("a ready after a reconnect refreshes only if the log moved while we were away", () => {
    assert.deepEqual(onStreamMessage(500, { kind: "ready", seq: 500 }), { last: 500, refresh: false });
    assert.deepEqual(onStreamMessage(500, { kind: "ready", seq: 520 }), { last: 520, refresh: true });
  });

  test("a change refreshes and advances the position, but never moves it backwards", () => {
    assert.deepEqual(onStreamMessage(500, { kind: "change", seq: 501 }), { last: 501, refresh: true });
    assert.deepEqual(onStreamMessage(501, { kind: "change", seq: 499 }), { last: 501, refresh: true });
  });

  test("a queue signal has no position but still refreshes", () => {
    assert.deepEqual(onStreamMessage(501, { kind: "change" }), { last: 501, refresh: true });
    assert.deepEqual(onStreamMessage(null, { kind: "change" }), { last: null, refresh: true });
  });

  test("a resync (too far behind) refreshes and jumps to the new position", () => {
    assert.deepEqual(onStreamMessage(10, { kind: "resync", seq: 900 }), { last: 900, refresh: true });
  });
});
