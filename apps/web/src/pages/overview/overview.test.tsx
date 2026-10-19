import { describe, expect, test } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { apiError, renderApp } from "../../test/harness";
import { widgets } from "../../test/data";

/** A widget's frame once it has loaded. */
const widget = (title: string) =>
  waitFor(() => {
    const frame = screen.getByRole("heading", { name: title }).closest("section") as HTMLElement;
    expect(frame.getAttribute("aria-busy")).toBeNull();
    return frame;
  });
const focusData = (over: Partial<ReturnType<typeof widgets>["focus"]> = {}) => ({ ...widgets().focus, ...over });
const dashboardCalls = (server: { requests: string[] }) => server.requests.filter((r) => r.startsWith("GET /api/app/dashboard/"));

describe("a project's Overview", () => {
  test("is the project's own dashboard: every widget reads that project, and the workspace page reads none", async () => {
    const { server } = renderApp("/p/AA/overview");
    await screen.findByRole("heading", { level: 1, name: "Overview of Alpha" });
    for (const title of ["Focus", "Needs attention", "Project progress", "Throughput", "Who's doing the work", "Agents", "Sync health", "Recent activity"]) await widget(title);
    const calls = dashboardCalls(server);
    expect(calls.length).toBeGreaterThanOrEqual(9);
    expect(calls.every((c) => c.includes("project=AA"))).toBe(true);
    expect(calls.some((c) => c.startsWith("GET /api/app/dashboard/focus"))).toBe(true);
  });

  test("the workspace dashboard asks for no project, and never for Focus", async () => {
    const { server } = renderApp("/");
    await screen.findByText("Open tickets");
    await widget("Project progress");
    const calls = dashboardCalls(server);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => !c.includes("project="))).toBe(true);
    expect(calls.some((c) => c.includes("/focus"))).toBe(false);
  });

  test("the key numbers say 'in this project' and count the agents that acted there", async () => {
    renderApp("/p/AA/overview");
    const tile = async (label: string) => (await screen.findByText(label)).closest(".card") as HTMLElement;
    expect(within(await tile("Open tickets")).getByText("in this project")).toBeTruthy();
    expect(within(await tile("Agents active")).getByText("changed something in 7 days")).toBeTruthy();
    expect(screen.queryByText("Agents connected")).toBeNull();
    expect((await screen.findByRole("link", { name: /Stale map nodes.*described/ })).getAttribute("href")).toBe("/p/AA/map"); // the tile is the link
    expect(screen.getByRole("link", { name: /Stale docs.*possibly out of date/ }).getAttribute("href")).toBe("/p/AA/docs");
  });

  test("Focus lists what waited longest, what sat longest and agents gone quiet, each linking to its ticket", async () => {
    renderApp("/p/AA/overview");
    const focus = await widget("Focus");
    const section = (title: RegExp) => within(focus).getByText(title).parentElement as HTMLElement; // the label sits inside its section
    const review = section(/Waiting longest for review/);
    expect(within(review).getByRole("link", { name: /AA-6.*Add rate limiting.*4 days/ }).getAttribute("href")).toBe("/p/AA?t=AA-6");
    const aging = section(/In progress the longest/);
    expect(within(aging).getByRole("link", { name: /AA-4.*Refactor auth.*9 days/ }).getAttribute("href")).toBe("/p/AA?t=AA-4");
    expect(within(section(/Agents gone quiet/)).getByText(/CI bot/)).toBeTruthy();
    expect(within(focus).getByRole("link", { name: "2 decisions still proposed" }).getAttribute("href")).toBe("/p/AA/decisions");
    expect(within(focus).getByRole("link", { name: "3 members · you are admin" }).getAttribute("href")).toBe("/p/AA/members");
  });

  test("when nothing is stuck, it says so instead of showing empty lists", async () => {
    renderApp("/p/AA/overview", (s) => s.on("GET /api/app/dashboard/focus", focusData({ aging: [], waitingReview: [], quiet: [], proposedDecisions: 1, members: { count: 1, myRole: "admin" } })));
    const focus = await widget("Focus");
    expect(within(focus).getByText(/Nothing is stuck/)).toBeTruthy();
    expect(within(focus).getByRole("link", { name: "1 decision still proposed" })).toBeTruthy(); // singular
    expect(within(focus).getByRole("link", { name: "1 member · you are admin" })).toBeTruthy();
  });

  test("a project with no tickets says how to start, not that nothing is stuck", async () => {
    renderApp("/p/AA/overview", (s) => s.on("GET /api/app/dashboard/focus", focusData({ aging: [], waitingReview: [], quiet: [], tickets: 0 })));
    const focus = await widget("Focus");
    expect(within(focus).getByText(/No tickets yet/)).toBeTruthy();
    expect(within(focus).getByRole("link", { name: /Add the first one on the board/ }).getAttribute("href")).toBe("/p/AA");
    expect(within(focus).queryByText(/Nothing is stuck/)).toBeNull();
  });

  test("a widget that fails says so inside its own frame and can be retried, without stopping the others", async () => {
    let healthy = false; // reads are retried, so it has to keep failing until told otherwise
    renderApp("/p/AA/overview", (s) => s.on("GET /api/app/dashboard/focus", () => (healthy ? focusData() : apiError(500, "internal", "Internal error"))));
    const alert = await waitFor(() => within(screen.getByRole("heading", { name: "Focus" }).closest("section") as HTMLElement).getByRole("alert"), { timeout: 8000 }); // reads are retried first
    await widget("Needs attention"); // the others loaded
    healthy = true;
    await userEvent.setup().click(within(alert).getByRole("button", { name: "Try again" }));
    await within(await widget("Focus")).findByText(/Waiting longest for review/);
  }, 15_000);

  test("the sidebar leads with Overview, and the page offers the board", async () => {
    renderApp("/p/AA/overview");
    await screen.findByRole("heading", { level: 1, name: "Overview of Alpha" });
    const nav = screen.getByRole("navigation");
    expect(within(nav).getByRole("link", { name: "Overview" }).getAttribute("href")).toBe("/p/AA/overview");
    expect(screen.getByRole("link", { name: "Open the board" }).getAttribute("href")).toBe("/p/AA");
  });

  test("a project you are not in is a plain not found", async () => {
    renderApp("/p/AA/overview", (s) => {
      s.on("GET /api/app/dashboard/focus", apiError(404, "not_found", "Project AA not found"));
      s.on("GET /api/app/projects/AA/board", apiError(404, "not_found", "Project AA not found"));
    });
    expect(await screen.findAllByText(/not found/i)).not.toHaveLength(0);
  });
});
