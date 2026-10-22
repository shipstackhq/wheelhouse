import { describe, expect, test } from "vitest";
import { render } from "@testing-library/react";
import { PRIORITY_LABEL, PRIORITY_ORDER, PriorityIcon } from "./priority-icon";

const svg = (p: string) => render(<PriorityIcon priority={p} />).container.querySelector("svg")!;

describe("a priority's icon", () => {
  test("every priority is drawn differently, and says which it is to tests", () => {
    expect(new Set(PRIORITY_ORDER.map((p) => svg(p).innerHTML)).size).toBe(5);
    for (const p of PRIORITY_ORDER) expect(svg(p).getAttribute("data-priority")).toBe(p);
  });
  test("low, medium and high fill one, two and three bars", () => {
    const filled = (p: string) => [...svg(p).querySelectorAll("rect")].filter((r) => r.getAttribute("opacity") === "1").length;
    expect([filled("low"), filled("medium"), filled("high")]).toEqual([1, 2, 3]);
    expect(svg("low").querySelectorAll("rect")).toHaveLength(3);
  });
  test("urgent is a red alert square and none is three dashes", () => {
    expect(svg("urgent").getAttribute("class")).toContain("text-danger");
    expect(svg("none").querySelectorAll("rect")).toHaveLength(0);
    expect(svg("none").querySelector("path")?.getAttribute("d")).toContain("h2.2");
  });
  test("it is decorative; the labels name the priorities, most pressing first and none last", () => {
    expect(svg("high").getAttribute("aria-hidden")).toBe("true");
    expect(PRIORITY_ORDER.map((p) => PRIORITY_LABEL[p])).toEqual(["Urgent", "High", "Medium", "Low", "No priority"]);
  });
});
