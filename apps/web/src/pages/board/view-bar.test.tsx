import { beforeEach, describe, expect, test } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp } from "../../test/harness";
import { board, issue } from "../../test/data";

/** The search, filter and display controls over the list (and the board). */
beforeEach(() => localStorage.removeItem("wh:layout:AA"));

const PROJECTS = [{ id: "p1", name: "Launch", status: "active" as const, milestones: [] }];
const CYCLES = [{ number: 2, name: "Autumn", startsAt: "2026-10-01T00:00:00.000Z", endsAt: "2026-10-14T00:00:00.000Z", state: "current" as const }];
const RICH = board("AA", {
  projects: PROJECTS,
  cycles: CYCLES,
  issues: [
    issue({ number: 1, title: "Fix login bug", statusId: "c-todo", priority: "high", assigneeId: "u1", labels: ["auth"], projectId: "p1", cycle: 2, position: 2 }),
    issue({ number: 2, title: "Write docs", statusId: "c-backlog", priority: "none", position: 1 }),
    issue({ number: 3, title: "Bug in billing", statusId: "c-todo", priority: "urgent", assigneeId: "u2", labels: ["billing"], position: 1 }),
    issue({ number: 4, title: "Ship it", statusId: "c-done", priority: "low", assigneeId: "u1", position: 1 }),
  ],
});
const open = (setup: Parameters<typeof renderApp>[1] = () => {}) => renderApp("/t/AA", (s) => (s.on("GET /api/app/teams/AA/board", RICH), setup(s)));
const titles = () => [...document.querySelectorAll("[data-issue]")].map((li) => li.getAttribute("data-issue"));
const groups = () => screen.getAllByRole("region").map((r) => r.getAttribute("aria-label"));
const openMenu = async (user: ReturnType<typeof userEvent.setup>, name: string) => {
  await user.click(screen.getByRole("button", { name }));
  return within(await screen.findByRole("dialog"));
};

describe("search", () => {
  test("narrows the list as you type, every word in the ref, title or a label; empty groups go while it does", async () => {
    const user = userEvent.setup();
    open();
    await screen.findByText("Fix login bug");
    expect(groups()).toHaveLength(6);
    await user.type(screen.getByRole("searchbox", { name: "Search issues" }), "bug");
    await waitFor(() => expect(titles()).toEqual(["AA-3", "AA-1"]));
    expect(groups()).toEqual(["Todo"]);
    await user.type(screen.getByRole("searchbox", { name: "Search issues" }), " billing");
    await waitFor(() => expect(titles()).toEqual(["AA-3"]));
    await user.clear(screen.getByRole("searchbox", { name: "Search issues" }));
    await waitFor(() => expect(titles()).toHaveLength(4));
    expect(groups()).toHaveLength(6);
  });
  test("with nothing found, the list says so and one click brings everything back", async () => {
    const user = userEvent.setup();
    open();
    await screen.findByText("Fix login bug");
    await user.type(screen.getByRole("searchbox", { name: "Search issues" }), "zzzz");
    expect(await screen.findByText("No issues match.")).toBeTruthy();
    await user.click(screen.getAllByRole("button", { name: "Clear filters" })[0]);
    await waitFor(() => expect(titles()).toHaveLength(4));
    expect((screen.getByRole("searchbox", { name: "Search issues" }) as HTMLInputElement).value).toBe("");
  });
  test("a search is not remembered, but is not lost by changing the layout", async () => {
    const user = userEvent.setup();
    const first = open();
    await screen.findByText("Fix login bug");
    await user.type(screen.getByRole("searchbox", { name: "Search issues" }), "ship");
    await user.click(within(screen.getByRole("group", { name: "Layout" })).getByRole("button", { name: "board" }));
    await waitFor(() => expect(document.querySelectorAll("[data-column]").length).toBe(6));
    expect(screen.queryByText("Fix login bug")).toBeNull();
    expect(screen.getByText("Ship it")).toBeTruthy();
    first.unmount();
    open();
    await screen.findByText("Fix login bug");
    expect((screen.getByRole("searchbox", { name: "Search issues" }) as HTMLInputElement).value).toBe("");
  });
});

describe("filters", () => {
  test("the Filter menu has a section for each way to narrow, with the team's own options", async () => {
    const user = userEvent.setup();
    open();
    await screen.findByText("Fix login bug");
    const m = await openMenu(user, "Filter issues");
    for (const section of ["Status", "Priority", "Assignee", "Label", "Project", "Cycle"]) expect(m.getByRole("group", { name: section })).toBeTruthy();
    expect(within(m.getByRole("group", { name: "Assignee" })).getAllByRole("checkbox").map((c) => c.parentElement?.textContent)).toEqual(["Ada Lovelace", "Grace Hopper", "Unassigned"]);
    expect(within(m.getByRole("group", { name: "Project" })).getAllByRole("checkbox").map((c) => c.parentElement?.textContent)).toEqual(["Launch", "No project"]);
    expect(within(m.getByRole("group", { name: "Cycle" })).getAllByRole("checkbox").map((c) => c.parentElement?.textContent)).toEqual(["Cycle 2: Autumn", "No cycle"]);
    expect(within(m.getByRole("group", { name: "Label" })).getAllByRole("checkbox").map((c) => c.parentElement?.textContent)).toEqual(["auth", "billing"]);
  });
  test("choosing a value keeps those issues, shows a chip and counts on the button; the chip takes it off", async () => {
    const user = userEvent.setup();
    open();
    await screen.findByText("Fix login bug");
    const m = await openMenu(user, "Filter issues");
    await user.click(within(m.getByRole("group", { name: "Priority" })).getByRole("checkbox", { name: "Urgent" }));
    await waitFor(() => expect(titles()).toEqual(["AA-3"]));
    await user.click(within(m.getByRole("group", { name: "Priority" })).getByRole("checkbox", { name: "High" }));
    await waitFor(() => expect(titles()).toEqual(["AA-3", "AA-1"])); // either value keeps an issue
    await user.click(within(m.getByRole("group", { name: "Assignee" })).getByRole("checkbox", { name: "Ada Lovelace" }));
    await waitFor(() => expect(titles()).toEqual(["AA-1"])); // different filters must all hold
    expect(screen.getByRole("button", { name: "Filter issues" }).textContent).toContain("3");
    expect([...document.querySelectorAll("[data-filter-chip]")].map((c) => c.textContent?.replace(/\s+/g, " ").trim())).toEqual(["Priority: Urgent", "Priority: High", "Assignee: Ada Lovelace"]);
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Remove filter Assignee: Ada Lovelace" }));
    await waitFor(() => expect(titles()).toEqual(["AA-3", "AA-1"]));
  });
  test("'Unassigned', 'No project' and 'No cycle' keep the issues without one", async () => {
    const user = userEvent.setup();
    open();
    await screen.findByText("Fix login bug");
    const m = await openMenu(user, "Filter issues");
    await user.click(within(m.getByRole("group", { name: "Project" })).getByRole("checkbox", { name: "No project" }));
    await waitFor(() => expect(titles()).toEqual(["AA-2", "AA-3", "AA-4"]));
    await user.click(within(m.getByRole("group", { name: "Cycle" })).getByRole("checkbox", { name: "No cycle" }));
    await user.click(within(m.getByRole("group", { name: "Assignee" })).getByRole("checkbox", { name: "Unassigned" }));
    await waitFor(() => expect(titles()).toEqual(["AA-2"]));
  });
  test("Clear in the menu or beside the chips removes every filter and the search", async () => {
    const user = userEvent.setup();
    open();
    await screen.findByText("Fix login bug");
    await user.type(screen.getByRole("searchbox", { name: "Search issues" }), "bug");
    const m = await openMenu(user, "Filter issues");
    await user.click(within(m.getByRole("group", { name: "Status" })).getByRole("checkbox", { name: "Todo" }));
    await waitFor(() => expect(document.querySelectorAll("[data-filter-chip]")).toHaveLength(1));
    await user.click(m.getByRole("button", { name: "Clear filters" }));
    await waitFor(() => expect(titles()).toHaveLength(4));
    expect(document.querySelectorAll("[data-filter-chip]")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: "Clear" })).toBeNull(); // nothing to clear
  });
  test("filters are remembered for the team and are separate from another team's", async () => {
    const user = userEvent.setup();
    const first = open();
    await screen.findByText("Fix login bug");
    const m = await openMenu(user, "Filter issues");
    await user.click(within(m.getByRole("group", { name: "Status" })).getByRole("checkbox", { name: "Done" }));
    await waitFor(() => expect(titles()).toEqual(["AA-4"]));
    first.unmount();
    open();
    await waitFor(() => expect(titles()).toEqual(["AA-4"]));
    expect(JSON.parse(localStorage.getItem("wh:issue-view:AA")!).filters.status).toEqual(["c-done"]);
    expect(localStorage.getItem("wh:issue-view:BB")).toBeNull();
  });
});

describe("display: grouping", () => {
  const group = async (user: ReturnType<typeof userEvent.setup>, by: string) => {
    const m = await openMenu(user, "Display options");
    await user.click(m.getByRole("radio", { name: by }));
    await user.keyboard("{Escape}");
  };
  test("by priority, assignee, project, cycle or nothing; empty groups are left out, 'none of these' is last", async () => {
    const user = userEvent.setup();
    open();
    await screen.findByText("Fix login bug");
    await group(user, "Priority");
    await waitFor(() => expect(groups()).toEqual(["Urgent", "High", "Low", "No priority"]));
    await group(user, "Assignee");
    await waitFor(() => expect(groups()).toEqual(["Ada Lovelace", "Grace Hopper", "Unassigned"]));
    await group(user, "Project");
    await waitFor(() => expect(groups()).toEqual(["Launch", "No project"]));
    await group(user, "Cycle");
    await waitFor(() => expect(groups()).toEqual(["Cycle 2: Autumn", "No cycle"]));
    await group(user, "No grouping");
    await waitFor(() => expect(groups()).toEqual(["All issues"]));
    expect(titles()).toEqual(["AA-2", "AA-3", "AA-4", "AA-1"]); // everything in the board order (positions 1, 1, 1, 2)
    await group(user, "Status");
    await waitFor(() => expect(groups()).toHaveLength(6));
  });
  test("the grouping is remembered for the team", async () => {
    const user = userEvent.setup();
    const first = open();
    await screen.findByText("Fix login bug");
    await group(user, "Assignee");
    await waitFor(() => expect(groups()).toContain("Unassigned"));
    first.unmount();
    open();
    await waitFor(() => expect(groups()).toEqual(["Ada Lovelace", "Grace Hopper", "Unassigned"]));
  });
  test("an issue added to a group starts with what the group is: its priority, its person, its project", async () => {
    const user = userEvent.setup();
    const { server } = open((s) => s.on("POST /api/app/teams/AA/issues", { issue: issue({ number: 50 }) }));
    await screen.findByText("Fix login bug");
    const add = async (label: string, title: string) => {
      await user.click(screen.getByRole("button", { name: `Add an issue to ${label}` }));
      await user.type(screen.getByLabelText(`New issue in ${label}`), `${title}{Enter}`);
    };
    await group(user, "Priority");
    await waitFor(() => expect(groups()[0]).toBe("Urgent"));
    await add("High", "from high");
    await group(user, "Assignee");
    await waitFor(() => expect(groups()[0]).toBe("Ada Lovelace"));
    await add("Grace Hopper", "from grace");
    await add("Unassigned", "from nobody");
    await group(user, "Project");
    await waitFor(() => expect(groups()[0]).toBe("Launch"));
    await add("Launch", "from launch");
    await group(user, "Cycle");
    await waitFor(() => expect(groups()[0]).toBe("Cycle 2: Autumn"));
    await add("Cycle 2: Autumn", "from cycle");
    await group(user, "Status");
    await waitFor(() => expect(groups()).toHaveLength(6));
    await add("Review", "from review");
    await waitFor(() => expect(server.sent("POST /api/app/teams/AA/issues")).toHaveLength(6));
    expect(server.sent("POST /api/app/teams/AA/issues").map((c) => c.body)).toEqual([
      { title: "from high", priority: "high" },
      { title: "from grace", assigneeId: "u2" },
      { title: "from nobody" },
      { title: "from launch", projectId: "p1" },
      { title: "from cycle", cycle: 2 },
      { title: "from review", status: "c-review" },
    ]);
  });
  test("groups fold by grouping: folding Todo does not fold a group of another grouping", async () => {
    const user = userEvent.setup();
    open();
    await screen.findByText("Fix login bug");
    await user.click(screen.getByRole("button", { name: "Todo, 2 issues" }));
    expect(screen.queryByText("Fix login bug")).toBeNull();
    await group(user, "Priority");
    expect(await screen.findByText("Fix login bug")).toBeTruthy();
  });
  test("on the board the columns are statuses: the grouping choices are off and say why", async () => {
    localStorage.setItem("wh:layout:AA", "board");
    const user = userEvent.setup();
    open();
    await screen.findByText("Fix login bug");
    const m = await openMenu(user, "Display options");
    expect(m.getByText("The board's columns are its statuses.")).toBeTruthy();
    for (const r of m.getAllByRole("radio")) expect((r as HTMLInputElement).disabled).toBe(true);
    expect((m.getByRole("radio", { name: "Status" }) as HTMLInputElement).checked).toBe(true);
  });
});

describe("display: ordering", () => {
  const order = async (user: ReturnType<typeof userEvent.setup>, label: string) => {
    const m = await openMenu(user, "Display options");
    await user.selectOptions(m.getByLabelText("Ordering"), label);
    return m;
  };
  test("inside every group by the chosen field, with a button for the direction", async () => {
    const user = userEvent.setup();
    open();
    await screen.findByText("Fix login bug");
    expect(titles()).toEqual(["AA-2", "AA-3", "AA-1", "AA-4"]); // manual: the board order
    const m = await order(user, "Title");
    await waitFor(() => expect(titles()).toEqual(["AA-2", "AA-3", "AA-1", "AA-4"])); // grouped by status, so Todo's two are now by title: Bug in billing, Fix login bug
    await user.click(m.getByRole("radio", { name: "No grouping" }));
    await waitFor(() => expect(titles()).toEqual(["AA-3", "AA-1", "AA-4", "AA-2"])); // Bug in billing, Fix login bug, Ship it, Write docs
    await user.click(m.getByRole("button", { name: "Ascending: switch to descending" }));
    await waitFor(() => expect(titles()).toEqual(["AA-2", "AA-4", "AA-1", "AA-3"]));
    expect(m.getByRole("button", { name: "Descending: switch to ascending" })).toBeTruthy();
  });
  test("by priority the most pressing comes first; manual has no direction", async () => {
    const user = userEvent.setup();
    open();
    await screen.findByText("Fix login bug");
    const m = await openMenu(user, "Display options");
    expect((m.getByRole("button", { name: /switch to/ }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(m.getByRole("radio", { name: "No grouping" }));
    await user.selectOptions(m.getByLabelText("Ordering"), "Priority");
    await waitFor(() => expect(titles()).toEqual(["AA-3", "AA-1", "AA-4", "AA-2"]));
    expect((m.getByRole("button", { name: /switch to/ }) as HTMLButtonElement).disabled).toBe(false);
  });
  test("the ordering is remembered", async () => {
    const user = userEvent.setup();
    const first = open();
    await screen.findByText("Fix login bug");
    await order(user, "Number");
    await waitFor(() => expect(JSON.parse(localStorage.getItem("wh:issue-view:AA")!).sort.key).toBe("number"));
    first.unmount();
    open();
    await screen.findByText("Fix login bug");
    const m = await openMenu(userEvent.setup(), "Display options");
    expect((m.getByLabelText("Ordering") as HTMLSelectElement).value).toBe("number");
  });
});
