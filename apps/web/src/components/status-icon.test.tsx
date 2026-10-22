import { describe, expect, test } from "vitest";
import { render } from "@testing-library/react";
import { ROLE_COLOR, StatusIcon, statusColor } from "./status-icon";

const svg = (role: string, color: Parameters<typeof statusColor>[1] = null) => render(<StatusIcon role={role} color={color} />).container.querySelector("svg")!;

describe("a status's icon", () => {
  test("each role is drawn differently, so a stage reads without its name", () => {
    const shapes = ["backlog", "todo", "in_progress", "review", "done", "canceled"].map((r) => svg(r).innerHTML);
    expect(new Set(shapes).size).toBe(6);
    expect(svg("backlog").innerHTML).toContain("stroke-dasharray");
    expect(svg("done").querySelector("circle")?.getAttribute("fill")).toBe("currentColor");
  });
  test("it is decorative, and says its role to tests", () => {
    expect(svg("review").getAttribute("aria-hidden")).toBe("true");
    expect(svg("review").getAttribute("data-status-icon")).toBe("review");
  });
  test("its colour is the team's choice, else the role's, else grey", () => {
    expect(statusColor("done", "violet")).toBe("violet");
    expect(statusColor("done", null)).toBe(ROLE_COLOR.done);
    expect(statusColor("something-new", null)).toBe("slate"); // a role this version does not know is grey, not an error
    expect(svg("in_progress", "rose").getAttribute("class")).toContain("text-rose-500");
    expect(svg("in_progress").getAttribute("class")).toContain("text-amber-500");
  });
});
