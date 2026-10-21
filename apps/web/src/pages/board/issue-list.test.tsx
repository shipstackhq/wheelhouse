import { beforeEach, describe, expect, test } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { apiError, renderApp } from "../../test/harness";
import { board, issue, STATUSES, detail } from "../../test/data";

/** The team page as a list (the default for a team that has not chosen the board). */
beforeEach(() => localStorage.removeItem("wh:layout:AA"));

const open = (setup: Parameters<typeof renderApp>[1] = () => {}, path = "/t/AA") => renderApp(path, setup);
const group = async (name: string) => within(await screen.findByRole("region", { name }));
const row = (ref: string) => document.querySelector(`[data-issue="${ref}"]`) as HTMLElement;

describe("the issue list", () => {
  test("is what a team gets by default: a group for every status in board order, empty ones included, each with its count", async () => {
    open();
    await screen.findByText("Write the plan");
    expect(screen.getAllByRole("region").map((r) => r.getAttribute("aria-label"))).toEqual(STATUSES.map((s) => s.name));
    expect(screen.getByRole("button", { name: "Backlog, 1 issue" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Todo, 2 issues" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Review, 0 issues" })).toBeTruthy();
    expect(screen.queryByText("Fix the crash")).toBeTruthy();
    expect(document.querySelector('[data-column]')).toBeNull(); // no board
  });

  test("a row has the issue's priority, ref, status, title, labels and assignee, and is in its status's group in board order", async () => {
    open((s) => s.on("GET /api/app/teams/AA/board", board("AA", { issues: [issue({ number: 7, title: "Seven", statusId: "c-todo", priority: "high", labels: ["docs", "api"], assigneeId: "u2", position: 2 }), issue({ number: 6, title: "Six", statusId: "c-todo", position: 1 })] })));
    const todo = await group("Todo");
    await todo.findByText("Seven");
    expect(todo.getAllByRole("listitem").map((li) => li.getAttribute("data-issue"))).toEqual(["AA-6", "AA-7"]);
    const r = within(row("AA-7"));
    expect(r.getByText("AA-7")).toBeTruthy();
    expect(r.getByRole("button", { name: "Priority of AA-7: High" })).toBeTruthy();
    expect(r.getByRole("button", { name: "Status of AA-7: Todo" })).toBeTruthy();
    expect(r.getByRole("button", { name: "Assignee of AA-7: Grace Hopper" })).toBeTruthy();
    expect(r.getByText("docs")).toBeTruthy();
    expect(r.getByText("api")).toBeTruthy();
    expect(within(row("AA-6")).getByRole("button", { name: "Priority of AA-6: No priority" })).toBeTruthy();
    expect(within(row("AA-6")).getByRole("button", { name: "Assignee of AA-6: nobody" })).toBeTruthy();
  });

  test("a row says when an agent made it, which project and cycle it is in, how many comments it has, and shows only three labels", async () => {
    open((s) =>
      s.on("GET /api/app/teams/AA/board", board("AA", {
        projects: [{ id: "p1", name: "Launch", status: "active", milestones: [] }],
        cycles: [{ number: 3, name: "Autumn", startsAt: "2026-10-01T00:00:00.000Z", endsAt: "2026-10-14T00:00:00.000Z", state: "current" }],
        issues: [issue({ number: 9, title: "Busy one", createdByKind: "agent", projectId: "p1", cycle: 3, commentCount: 4, labels: ["a", "b", "c", "d", "e"] })],
      })),
    );
    await screen.findByText("Busy one");
    const r = within(row("AA-9"));
    expect(r.getByTitle("Created by an agent")).toBeTruthy();
    expect(r.getByText("Launch")).toBeTruthy();
    expect(row("AA-9").querySelector("[data-cycle-chip]")?.textContent).toContain("3");
    expect(r.getByTitle("4 comments")).toBeTruthy();
    expect(r.queryByText("d")).toBeNull();
    expect(r.getByText("+2").getAttribute("title")).toBe("d, e");
  });

  test("a group folds away and is still folded after a reload", async () => {
    const user = userEvent.setup();
    const first = open();
    await screen.findByText("Fix the crash");
    await user.click(screen.getByRole("button", { name: "Todo, 2 issues" }));
    expect(screen.queryByText("Fix the crash")).toBeNull();
    expect(screen.getByRole("button", { name: "Todo, 2 issues" }).getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByText("Write the plan")).toBeTruthy(); // the others stay
    first.unmount();
    open();
    await screen.findByText("Write the plan");
    expect(screen.queryByText("Fix the crash")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Todo, 2 issues" }));
    expect(await screen.findByText("Fix the crash")).toBeTruthy();
  });

  describe("changing an issue in its row", () => {
    test("the status menu moves it by the status's id, and the list is read again", async () => {
      const { server } = open((s) => s.on("POST /api/app/issues/AA-1/move", { issue: issue({ number: 1 }) }));
      const user = userEvent.setup();
      await screen.findByText("Write the plan");
      await user.click(within(row("AA-1")).getByRole("button", { name: "Status of AA-1: Backlog" }));
      expect((await screen.findByRole("menuitem", { name: "Backlog" })).getAttribute("aria-current")).toBe("true");
      await user.click(screen.getByRole("menuitem", { name: "Review" }));
      await waitFor(() => expect(server.sent("POST /api/app/issues/AA-1/move")).toHaveLength(1));
      expect(server.sent("POST /api/app/issues/AA-1/move")[0].body).toEqual({ status: "c-review" });
      await waitFor(() => expect(server.sent("GET /api/app/teams/AA/board").length).toBeGreaterThan(1));
    });
    test("the priority menu lists the priorities most pressing first and saves the choice with the version", async () => {
      const { server } = open((s) => s.on("PATCH /api/app/issues/AA-1", { issue: issue({ number: 1 }) }));
      const user = userEvent.setup();
      await screen.findByText("Write the plan");
      await user.click(within(row("AA-1")).getByRole("button", { name: "Priority of AA-1: High" }));
      const items = await screen.findAllByRole("menuitem");
      expect(items.map((i) => i.querySelector("span.truncate")?.textContent)).toEqual(["Urgent", "High", "Medium", "Low", "No priority"]);
      await user.click(screen.getByRole("menuitem", { name: "Urgent" }));
      await waitFor(() => expect(server.sent("PATCH /api/app/issues/AA-1")).toHaveLength(1));
      expect(server.sent("PATCH /api/app/issues/AA-1")[0].body).toEqual({ priority: "urgent", version: 1 });
    });
    test("the assignee menu offers nobody and each member, and saves the person's id, or null for nobody", async () => {
      const { server } = open((s) => s.on("PATCH /api/app/issues/AA-2", { issue: issue({ number: 2 }) }));
      const user = userEvent.setup();
      await screen.findByText("Build the board");
      await user.click(within(row("AA-2")).getByRole("button", { name: "Assignee of AA-2: nobody" }));
      expect((await screen.findAllByRole("menuitem")).map((i) => i.querySelector("span.truncate")?.textContent)).toEqual(["Unassigned", "Ada Lovelace", "Grace Hopper"]);
      await user.click(screen.getByRole("menuitem", { name: "Ada Lovelace" }));
      await waitFor(() => expect(server.sent("PATCH /api/app/issues/AA-2")).toHaveLength(1));
      expect(server.sent("PATCH /api/app/issues/AA-2")[0].body).toEqual({ assigneeId: "u1", version: 1 });
    });
    test("choosing what an issue already has sends nothing", async () => {
      const { server } = open();
      const user = userEvent.setup();
      await screen.findByText("Write the plan");
      await user.click(within(row("AA-1")).getByRole("button", { name: "Priority of AA-1: High" }));
      await user.click(await screen.findByRole("menuitem", { name: "High" }));
      await user.click(within(row("AA-1")).getByRole("button", { name: "Status of AA-1: Backlog" }));
      await user.click(await screen.findByRole("menuitem", { name: "Backlog" }));
      await user.click(within(row("AA-1")).getByRole("button", { name: "Assignee of AA-1: nobody" }));
      await user.click(await screen.findByRole("menuitem", { name: "Unassigned" }));
      expect(server.calls.filter((c) => c.method !== "GET")).toHaveLength(0);
    });
    test("a refusal is shown, and the list is read again so the row is as the server has it", async () => {
      const { server } = open((s) => s.on("PATCH /api/app/issues/AA-1", apiError(409, "conflict", "AA-1 was changed (version 2, you had 1). Re-read and retry.")));
      const user = userEvent.setup();
      await screen.findByText("Write the plan");
      await user.click(within(row("AA-1")).getByRole("button", { name: "Priority of AA-1: High" }));
      await user.click(await screen.findByRole("menuitem", { name: "Low" }));
      expect((await screen.findByRole("alert")).textContent).toContain("was changed");
      await waitFor(() => expect(server.sent("GET /api/app/teams/AA/board").length).toBeGreaterThan(1));
    });
  });

  describe("adding an issue", () => {
    test("each group has a + that opens a title box: Enter creates the issue in that status, by id", async () => {
      const { server } = open((s) => s.on("POST /api/app/teams/AA/issues", { issue: issue({ number: 50 }) }));
      const user = userEvent.setup();
      await screen.findByText("Write the plan");
      await user.click(screen.getByRole("button", { name: "Add an issue to Review" }));
      await user.type(screen.getByLabelText("New issue in Review"), "  A new one  {Enter}");
      await waitFor(() => expect(server.sent("POST /api/app/teams/AA/issues")).toHaveLength(1));
      expect(server.sent("POST /api/app/teams/AA/issues")[0].body).toEqual({ title: "A new one", status: "c-review" });
      expect(screen.queryByLabelText("New issue in Review")).toBeNull(); // the box closes
      await waitFor(() => expect(server.sent("GET /api/app/teams/AA/board").length).toBeGreaterThan(1));
    });
    test("Escape closes the box, and an empty title sends nothing", async () => {
      const { server } = open();
      const user = userEvent.setup();
      await screen.findByText("Write the plan");
      await user.click(screen.getByRole("button", { name: "Add an issue to Done" }));
      await user.type(screen.getByLabelText("New issue in Done"), "Never mind{Escape}");
      expect(screen.queryByLabelText("New issue in Done")).toBeNull();
      await user.click(screen.getByRole("button", { name: "Add an issue to Done" }));
      await user.type(screen.getByLabelText("New issue in Done"), "   {Enter}");
      expect(server.calls.filter((c) => c.method === "POST")).toHaveLength(0);
    });
  });

  describe("opening an issue", () => {
    const T = issue({ number: 1, title: "Write the plan", priority: "high" });
    test("the title opens it in the dialog (?t=), and closing puts the list back as it was", async () => {
      const { router } = open((s) => s.on("GET /api/app/issues/AA-1", detail(T)));
      const user = userEvent.setup();
      await user.click(await screen.findByRole("button", { name: "Write the plan" }));
      await screen.findByRole("dialog");
      expect(router.state.location.search).toBe("?t=AA-1");
      await user.keyboard("{Escape}");
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(router.state.location.search).toBe("");
    });
    test("a shared link with ?t= opens the issue over the list; the open issue's row is marked", async () => {
      open((s) => s.on("GET /api/app/issues/AA-1", detail(T)), "/t/AA?t=AA-1");
      await screen.findByRole("dialog");
      expect(row("AA-1").className).toContain("bg-accent/10");
      expect(row("AA-2").className).not.toContain("bg-accent/10");
    });
    test("previous and next in the dialog walk the list in the order it shows, across groups", async () => {
      open((s) => {
        s.on("GET /api/app/issues/AA-2", detail(issue({ number: 2, title: "Build the board", statusId: "c-todo" })));
        s.on("GET /api/app/issues/AA-3", detail(issue({ number: 3, title: "Fix the crash", statusId: "c-todo" })));
        s.on("GET /api/app/issues/AA-4", detail(issue({ number: 4, title: "Ship it", statusId: "c-done" })));
      }, "/t/AA?t=AA-3");
      const user = userEvent.setup();
      await screen.findByRole("dialog");
      await user.click(await screen.findByRole("button", { name: "Next issue in this column" }));
      await waitFor(() => expect(screen.getByRole("dialog").textContent).toContain("Ship it")); // the next group's first issue
    });
  });
});
