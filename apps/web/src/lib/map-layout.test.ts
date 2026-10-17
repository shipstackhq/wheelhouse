import { test } from "vitest";
import assert from "node:assert/strict";
import { breakCycles, violatesLeftToRight, dagreLayout } from "./map-layout";

test("breakCycles leaves an acyclic graph untouched", () => {
  const edges = [
    { source: "a", target: "b" },
    { source: "b", target: "c" },
  ];
  const out = breakCycles(["a", "b", "c"], edges);
  assert.deepEqual(
    out.map((e) => `${e.source}>${e.target}`).sort(),
    ["a>b", "b>c"],
  );
});

test("breakCycles reverses the back-edge that closes a simple cycle", () => {
  // a -> b -> c -> a: c->a is the back-edge DFS finds last, so it gets reversed to a->c.
  const edges = [
    { source: "a", target: "b" },
    { source: "b", target: "c" },
    { source: "c", target: "a" },
  ];
  const out = breakCycles(["a", "b", "c"], edges);
  // Still 3 edges — nothing dropped, the cycle-closing edge is only reversed for ranking.
  assert.equal(out.length, 3);
  assert.ok(out.some((e) => e.source === "a" && e.target === "b"));
  assert.ok(out.some((e) => e.source === "b" && e.target === "c"));
  assert.ok(out.some((e) => e.source === "a" && e.target === "c"), "the back-edge c->a is reversed to a->c");
  assert.ok(!out.some((e) => e.source === "c" && e.target === "a"), "the original cyclic direction is not fed to the ranker");
});

test("breakCycles handles a self-loop without infinite recursion", () => {
  const out = breakCycles(["a"], [{ source: "a", target: "a" }]);
  assert.ok(out.some((e) => e.source === "a" && e.target === "a"));
});

test("breakCycles is stable for disconnected components", () => {
  const edges = [
    { source: "a", target: "b" },
    { source: "x", target: "y" },
    { source: "y", target: "x" }, // a 2-cycle in a separate component
  ];
  const out = breakCycles(["a", "b", "x", "y"], edges);
  assert.equal(out.length, 3);
  assert.ok(out.some((e) => e.source === "a" && e.target === "b"));
});

test("violatesLeftToRight flags a node sitting left of something pointing into it", () => {
  const xOf = (id: string) => ({ src: 0 })[id as "src"];
  const { violates, minX } = violatesLeftToRight("tgt", 10, () => 200, ["src"], xOf);
  assert.equal(violates, true);
  assert.equal(minX, 240); // src.x(0) + width(200) + 40 margin
});

test("violatesLeftToRight passes when the node is already far enough right", () => {
  const xOf = (id: string) => ({ src: 0 })[id as "src"];
  const { violates } = violatesLeftToRight("tgt", 300, () => 200, ["src"], xOf);
  assert.equal(violates, false);
});

test("violatesLeftToRight ignores incoming nodes with unknown position", () => {
  const { violates } = violatesLeftToRight("tgt", 0, () => 200, ["ghost"], () => undefined);
  assert.equal(violates, false);
});

test("dagreLayout places a dependency to the left of its dependent (LR)", () => {
  // depends edge: fromNodeId = dependent, toNodeId = dependency (per the module's own doc comment).
  const nodes = [
    { id: "dependent", width: 100, height: 40 },
    { id: "dependency", width: 100, height: 40 },
  ];
  const result = dagreLayout(nodes, [{ source: "dependent", target: "dependency" }], "LR");
  const dependentX = result.get("dependent")!.x;
  const dependencyX = result.get("dependency")!.x;
  assert.ok(dependentX > dependencyX, "the dependent sits to the right of what it depends on");
});
