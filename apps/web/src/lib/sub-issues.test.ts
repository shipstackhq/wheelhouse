import { describe, expect, test } from "vitest";
import { arrangeRows, childrenIndex, descendantIds, parentCandidates, progressOf, relationsOf } from "./sub-issues";
import { issue } from "../test/data";

const roles: Record<string, string> = { "c-todo": "todo", "c-done": "done", "c-canceled": "canceled", "c-backlog": "backlog" };
const roleOf = (id: string) => roles[id] ?? null;
const t = (number: number, over: Partial<ReturnType<typeof issue>> = {}) => issue({ number, id: `i${number}`, title: `T${number}`, statusId: "c-todo", position: number, ...over });
const refs = (rows: { issue: { ref: string } }[]) => rows.map((r) => r.issue.ref);

// 1 ── 2 ── 4          5 (alone)
//   └─ 3               6 ── 7  (6 is in another group below)
const P1 = t(1);
const C2 = t(2, { parentId: "i1" });
const C3 = t(3, { parentId: "i1", statusId: "c-done" });
const G4 = t(4, { parentId: "i2", statusId: "c-canceled" });
const ALONE = t(5);
const P6 = t(6, { statusId: "c-backlog" });
const C7 = t(7, { parentId: "i6" });
const ALL = [P1, C2, C3, G4, ALONE, P6, C7];

describe("progress", () => {
  const index = childrenIndex(ALL);
  test("done out of all the direct sub-issues, canceled ones not counted at all", () => {
    expect(progressOf("i1", index, roleOf)).toEqual({ done: 1, total: 2 });
    expect(progressOf("i2", index, roleOf)).toEqual({ done: 0, total: 0 }); // its only child was canceled
    expect(progressOf("i6", index, roleOf)).toEqual({ done: 0, total: 1 });
  });
  test("an issue with no sub-issues has no progress", () => {
    expect(progressOf("i5", index, roleOf)).toBeNull();
    expect(progressOf("nope", index, roleOf)).toBeNull();
  });
  test("the index lists each parent's children in the order given", () => {
    expect(childrenIndex(ALL).get("i1")!.map((x) => x.ref)).toEqual(["AA-2", "AA-3"]);
    expect(childrenIndex([]).size).toBe(0);
  });
});

describe("what can be a parent", () => {
  test("not the issue itself and nothing below it at any depth; everything else can", () => {
    expect([...descendantIds(ALL, "i1")].sort()).toEqual(["i2", "i3", "i4"]);
    expect(refs(parentCandidates(ALL, "i1").map((x) => ({ issue: x })))).toEqual(["AA-5", "AA-6", "AA-7"]);
    expect(refs(parentCandidates(ALL, "i2").map((x) => ({ issue: x })))).toEqual(["AA-1", "AA-3", "AA-5", "AA-6", "AA-7"]); // its parent and siblings are fine
    expect(descendantIds(ALL, "i5").size).toBe(0);
  });
  test("bad data with a loop does not run forever", () => {
    const a = t(10, { parentId: "i11" });
    const b = t(11, { parentId: "i10" });
    expect([...descendantIds([a, b], "i10")].sort()).toEqual(["i10", "i11"]);
  });
});

describe("a group's rows", () => {
  const nest = { showSub: true, nest: true, folded: new Set<string>() };
  test("a sub-issue sits under its parent, indented, and a parent says how many it has here and how far along they are", () => {
    const rows = arrangeRows([P1, C2, C3, G4, ALONE], ALL, nest, roleOf);
    expect(rows.map((r) => [r.issue.ref, r.depth])).toEqual([["AA-1", 0], ["AA-2", 1], ["AA-4", 2], ["AA-3", 1], ["AA-5", 0]]);
    expect(rows[0]).toMatchObject({ childrenHere: 2, progress: { done: 1, total: 2 }, parentRef: null });
    expect(rows[1]).toMatchObject({ childrenHere: 1, parentRef: null }); // under its parent: no need to name it
    expect(rows[4]).toMatchObject({ childrenHere: 0, progress: null, parentRef: null });
  });
  test("a sub-issue is pulled up under its parent even when the list had it elsewhere", () => {
    const rows = arrangeRows([C2, ALONE, P1], ALL, nest, roleOf);
    expect(rows.map((r) => [r.issue.ref, r.depth])).toEqual([["AA-5", 0], ["AA-1", 0], ["AA-2", 1]]);
  });
  test("a sub-issue whose parent is in another group keeps its place and names its parent", () => {
    const rows = arrangeRows([C7, ALONE], ALL, nest, roleOf);
    expect(rows.map((r) => [r.issue.ref, r.depth, r.parentRef])).toEqual([["AA-7", 0, "AA-6"], ["AA-5", 0, null]]);
  });
  test("a parent's progress counts all its sub-issues, wherever they are shown, even ones the list does not have", () => {
    const rows = arrangeRows([P1], ALL, nest, roleOf);
    expect(rows[0]).toMatchObject({ childrenHere: 0, progress: { done: 1, total: 2 } });
  });
  test("folded parents hide everything below them", () => {
    const rows = arrangeRows([P1, C2, C3, G4, ALONE], ALL, { ...nest, folded: new Set(["i1"]) }, roleOf);
    expect(refs(rows)).toEqual(["AA-1", "AA-5"]);
    expect(arrangeRows([P1, C2, C3, G4], ALL, { ...nest, folded: new Set(["i2"]) }, roleOf).map((r) => r.issue.ref)).toEqual(["AA-1", "AA-2", "AA-3"]);
  });
  test("without nesting every issue is a row of its own, a sub-issue naming its parent", () => {
    const rows = arrangeRows([C3, P1, C7], ALL, { ...nest, nest: false }, roleOf);
    expect(rows.map((r) => [r.issue.ref, r.depth, r.parentRef])).toEqual([["AA-3", 0, "AA-1"], ["AA-1", 0, null], ["AA-7", 0, "AA-6"]]);
  });
  test("with sub-issues hidden only top-level issues are rows, still showing their progress", () => {
    const rows = arrangeRows([P1, C2, C3, ALONE], ALL, { ...nest, showSub: false }, roleOf);
    expect(refs(rows)).toEqual(["AA-1", "AA-5"]);
    expect(rows[0].progress).toEqual({ done: 1, total: 2 });
  });
  test("a loop in bad data places every issue once, as a row of its own, and does not hang", () => {
    const a = t(10, { parentId: "i11" });
    const b = t(11, { parentId: "i10" });
    expect(arrangeRows([a, b], [a, b], nest, roleOf).map((r) => [r.issue.ref, r.depth])).toEqual([["AA-10", 0], ["AA-11", 1]]);
  });
});

describe("relations for cards", () => {
  const rel = relationsOf(ALL, roleOf);
  test("a sub-issue knows its parent's ref, a top-level issue does not, and a parent with sub-issues has progress", () => {
    expect(rel.parentRef(C2)).toBe("AA-1");
    expect(rel.parentRef(P1)).toBeNull();
    expect(rel.parentRef(t(9, { parentId: "gone" }))).toBeNull(); // a parent that is not on the board
    expect(rel.progress(P1)).toEqual({ done: 1, total: 2 });
    expect(rel.progress(ALONE)).toBeNull();
  });
});
