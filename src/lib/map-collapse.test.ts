import { test } from "node:test";
import assert from "node:assert/strict";
import { remapCollapsedEdges } from "./map-collapse";

test("edges between visible nodes pass through unchanged", () => {
  const edges = [{ id: "e1", fromNodeId: "a", toNodeId: "b", kind: "depends" }];
  const out = remapCollapsedEdges(edges, (id) => id);
  assert.deepEqual(out, edges);
});

test("an edge to a hidden child is re-pointed to its visible collapsed ancestor", () => {
  const edges = [{ id: "e1", fromNodeId: "a", toNodeId: "child-of-b", kind: "depends" }];
  const nearestVisible = (id: string) => (id === "child-of-b" ? "b" : id);
  const out = remapCollapsedEdges(edges, nearestVisible);
  assert.equal(out.length, 1);
  assert.equal(out[0].fromNodeId, "a");
  assert.equal(out[0].toNodeId, "b");
});

test("duplicate edges created by redirection are merged with a ×N count label", () => {
  const edges: { id: string; fromNodeId: string; toNodeId: string; kind: string; label?: string }[] = [
    { id: "e1", fromNodeId: "a", toNodeId: "child1", kind: "depends" },
    { id: "e2", fromNodeId: "a", toNodeId: "child2", kind: "depends" },
    { id: "e3", fromNodeId: "a", toNodeId: "child3", kind: "depends" },
  ];
  const nearestVisible = (id: string) => (id.startsWith("child") ? "group" : id);
  const out = remapCollapsedEdges(edges, nearestVisible);
  assert.equal(out.length, 1);
  assert.equal(out[0].fromNodeId, "a");
  assert.equal(out[0].toNodeId, "group");
  assert.equal(out[0].label, "×3");
});

test("an existing label is preserved and a count is appended when merged", () => {
  const edges = [
    { id: "e1", fromNodeId: "a", toNodeId: "child1", kind: "depends", label: "REST" },
    { id: "e2", fromNodeId: "a", toNodeId: "child2", kind: "depends", label: "events" },
  ];
  const nearestVisible = (id: string) => (id.startsWith("child") ? "group" : id);
  const out = remapCollapsedEdges(edges, nearestVisible);
  assert.equal(out.length, 1);
  assert.equal(out[0].label, "REST ×2");
});

test("an edge collapsed to the same ancestor on both ends is dropped (not a self-loop)", () => {
  const edges = [{ id: "e1", fromNodeId: "child1", toNodeId: "child2", kind: "depends" }];
  const nearestVisible = () => "group";
  const out = remapCollapsedEdges(edges, nearestVisible);
  assert.equal(out.length, 0);
});

test("different edge kinds between the same two nodes are not merged together", () => {
  const edges = [
    { id: "e1", fromNodeId: "a", toNodeId: "child1", kind: "depends" },
    { id: "e2", fromNodeId: "a", toNodeId: "child2", kind: "implements" },
  ];
  const nearestVisible = (id: string) => (id.startsWith("child") ? "group" : id);
  const out = remapCollapsedEdges(edges, nearestVisible);
  assert.equal(out.length, 2);
});
