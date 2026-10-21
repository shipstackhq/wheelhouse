import { afterEach, describe, expect, test, vi } from "vitest";
import { LAYOUTS, loadFolded, loadLayout, saveFolded, saveLayout } from "./issue-layout";

afterEach(() => vi.restoreAllMocks());

describe("the layout choice", () => {
  test("a team that has not chosen gets the list; a choice is remembered for that team only", () => {
    localStorage.clear();
    expect(loadLayout("AA")).toBe("list");
    saveLayout("AA", "board");
    expect(loadLayout("AA")).toBe("board");
    expect(loadLayout("BB")).toBe("list");
    saveLayout("AA", "list");
    expect(loadLayout("AA")).toBe("list");
  });
  test("a stored value that is not a layout is ignored", () => {
    localStorage.setItem("wh:layout:AA", "grid");
    expect(loadLayout("AA")).toBe("list");
    expect(LAYOUTS).toEqual(["list", "board"]);
  });
  test("without storage it still answers, and saving does not throw", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    expect(loadLayout("AA")).toBe("list");
    expect(() => saveLayout("AA", "board")).not.toThrow();
    expect([...loadFolded("AA")]).toEqual([]);
    expect(() => saveFolded("AA", new Set(["x"]))).not.toThrow();
  });
});

describe("folded groups", () => {
  test("are remembered per team as a set of ids; junk in storage is ignored", () => {
    localStorage.clear();
    expect([...loadFolded("AA")]).toEqual([]);
    saveFolded("AA", new Set(["c-done", "c-canceled"]));
    expect([...loadFolded("AA")].sort()).toEqual(["c-canceled", "c-done"]);
    expect([...loadFolded("BB")]).toEqual([]);
    localStorage.setItem("wh:list-folded:AA", "{not json");
    expect([...loadFolded("AA")]).toEqual([]);
    localStorage.setItem("wh:list-folded:AA", JSON.stringify(["ok", 3, null, { a: 1 }]));
    expect([...loadFolded("AA")]).toEqual(["ok"]);
    localStorage.setItem("wh:list-folded:AA", JSON.stringify({ not: "a list" }));
    expect([...loadFolded("AA")]).toEqual([]);
  });
});
