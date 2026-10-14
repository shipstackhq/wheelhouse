import { test } from "node:test";
import assert from "node:assert/strict";
import { bucketOf, groupByBucket, BUCKETS } from "./session-buckets";

const H = 3600e3;
const now = Date.UTC(2026, 9, 13, 12, 0, 0);
const ago = (ms: number) => new Date(now - ms);

test("a session falls into exactly one bucket, and each bucket includes its upper bound", () => {
  assert.equal(bucketOf(ago(0), now), "h6");
  assert.equal(bucketOf(ago(6 * H), now), "h6");
  assert.equal(bucketOf(ago(6 * H + 1), now), "h12");
  assert.equal(bucketOf(ago(12 * H), now), "h12");
  assert.equal(bucketOf(ago(12 * H + 1), now), "h24");
  assert.equal(bucketOf(ago(24 * H), now), "h24");
  assert.equal(bucketOf(ago(24 * H + 1), now), "d7");
  assert.equal(bucketOf(ago(7 * 24 * H), now), "d7");
});

test("anything older than a week has no bucket (it is deleted), and a clock skew into the future counts as just now", () => {
  assert.equal(bucketOf(ago(7 * 24 * H + 1), now), null);
  assert.equal(bucketOf(new Date(now + 5 * H), now), "h6");
});

test("grouping keeps newest bucket first and leaves out empty buckets", () => {
  const groups = groupByBucket([
    { id: "a", bucket: "d7" as const },
    { id: "b", bucket: "h6" as const },
    { id: "c", bucket: "d7" as const },
  ]);
  assert.deepEqual(groups.map((g) => [g.id, g.sessions.map((s) => s.id)]), [["h6", ["b"]], ["d7", ["a", "c"]]]);
  assert.deepEqual(groupByBucket([]), []);
  assert.deepEqual(BUCKETS.map((b) => b.id), ["h6", "h12", "h24", "d7"]);
});
