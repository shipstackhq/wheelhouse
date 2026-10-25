import { describe, expect, test } from "vitest";
import { crumbsFor } from "./breadcrumbs";

const TEAMS = [{ key: "AA", name: "Alpha" }];
const trail = (path: string) => crumbsFor(path, "Analytical Engines", TEAMS).map((c) => c.label + (c.to ? ` -> ${c.to}` : ""));

describe("the breadcrumb trail", () => {
  test("starts at the workspace and ends, unlinked, at the page", () => {
    expect(trail("/")).toEqual(["Analytical Engines -> /", "Home"]);
    expect(trail("/api-keys")).toEqual(["Analytical Engines -> /", "API keys"]);
  });

  test("a team's issues page is its own address, and a section sits under the team", () => {
    expect(trail("/t/AA")).toEqual(["Analytical Engines -> /", "Alpha", "Issues"]);
    expect(trail("/t/AA/docs")).toEqual(["Analytical Engines -> /", "Alpha -> /t/AA", "Docs"]);
  });

  test("an item inside a section links back to the section and is named by its kind", () => {
    expect(trail("/t/AA/decisions/7")).toEqual(["Analytical Engines -> /", "Alpha -> /t/AA", "Decisions -> /t/AA/decisions", "Decision"]);
    expect(trail("/t/AA/cycles/3").at(-1)).toBe("Cycle");
    expect(trail("/projects/abc")).toEqual(["Analytical Engines -> /", "Projects -> /projects", "Project"]);
  });

  test("admin and new-team pages, and a team that is not in the list falls back to its key", () => {
    expect(trail("/admin/invites")).toEqual(["Analytical Engines -> /", "Admin", "Invite a new workspace"]);
    expect(trail("/teams/new")).toEqual(["Analytical Engines -> /", "Teams", "New team"]);
    expect(trail("/inbox")).toEqual(["Analytical Engines -> /", "Inbox"]);
    expect(trail("/t/ZZ/map")[1]).toBe("ZZ -> /t/ZZ");
  });
});
