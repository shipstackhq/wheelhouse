import { test } from "vitest";
import assert from "node:assert/strict";
import { groupHistory, GROUP_GAP_MS, type HistoryActor } from "./history-groups";

const at = (minAgo: number) => new Date(Date.UTC(2026, 9, 14, 12, 0, 0) - minAgo * 60e3);
const ev = (id: number, name: string, minAgo: number, kind: "human" | "agent" = "human"): HistoryActor & { id: number } => ({ id, actorKind: kind, actorName: name, createdAt: at(minAgo) });
const ids = (g: { items: { id: number }[] }[]) => g.map((x) => x.items.map((i) => i.id));

test("consecutive changes by the same actor become one group", () => {
  const g = groupHistory([ev(1, "Demo", 1), ev(2, "Demo", 2), ev(3, "Demo", 5)]);
  assert.deepEqual(ids(g), [[1, 2, 3]]);
  assert.equal(g[0].actorName, "Demo");
});

test("a different actor in between splits the groups, and order is kept", () => {
  assert.deepEqual(ids(groupHistory([ev(1, "Demo", 1), ev(2, "Bot", 2, "agent"), ev(3, "Bot", 3, "agent"), ev(4, "Demo", 4)])), [[1], [2, 3], [4]]);
});

test("the same name as a person and as an agent are different doers", () => {
  assert.deepEqual(ids(groupHistory([ev(1, "Sam", 1, "human"), ev(2, "Sam", 2, "agent")])), [[1], [2]]);
});

test("the same actor returning after a long gap starts a new group", () => {
  const gapMin = GROUP_GAP_MS / 60e3;
  assert.deepEqual(ids(groupHistory([ev(1, "Bot", 1, "agent"), ev(2, "Bot", 1 + gapMin, "agent")])), [[1, 2]], "exactly the gap still joins");
  assert.deepEqual(ids(groupHistory([ev(1, "Bot", 1, "agent"), ev(2, "Bot", 2 + gapMin, "agent")])), [[1], [2]], "just over the gap splits");
});

test("a group knows its newest and oldest time", () => {
  const [g] = groupHistory([ev(1, "Demo", 1), ev(2, "Demo", 9)]);
  assert.equal(new Date(g.newestAt).getTime(), at(1).getTime());
  assert.equal(new Date(g.oldestAt).getTime(), at(9).getTime());
});

test("nothing in, nothing out; a single event is a group of one", () => {
  assert.deepEqual(groupHistory([]), []);
  assert.deepEqual(ids(groupHistory([ev(1, "Demo", 1)])), [[1]]);
});

test("a custom gap is respected", () => {
  assert.deepEqual(ids(groupHistory([ev(1, "Demo", 1), ev(2, "Demo", 8)], 5 * 60e3)), [[1], [2]]);
});
