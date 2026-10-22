import { beforeEach, describe, expect, test } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp } from "../../test/harness";
import { board, detail, issue } from "../../test/data";

beforeEach(() => localStorage.removeItem("wh:layout:AA"));

// AA-1 is an epic with three sub-issues (one done, one in another group); AA-2 has one of its own.
const EPIC = issue({ number: 1, title: "Epic", statusId: "c-todo", position: 1 });
const A = issue({ number: 2, title: "Task A", statusId: "c-todo", parentId: EPIC.id, position: 2 });
const B = issue({ number: 3, title: "Task B", statusId: "c-done", parentId: EPIC.id, position: 1 });
const D = issue({ number: 4, title: "Detail", statusId: "c-todo", parentId: A.id, position: 3 });
const LOOSE = issue({ number: 5, title: "Loose", statusId: "c-todo", position: 4 });
const AWAY = issue({ number: 6, title: "Elsewhere", statusId: "c-backlog", parentId: EPIC.id, position: 1 });
const BOARD = board("AA", { issues: [EPIC, A, B, D, LOOSE, AWAY] });
const kid = (t: ReturnType<typeof issue>, status: string, over: object = {}) => ({ ref: t.ref, title: t.title, priority: t.priority, status, done: false, canceled: false, assigneeId: null, ...over });

const open = (setup: Parameters<typeof renderApp>[1] = () => {}, path = "/t/AA") => renderApp(path, (s) => (s.on("GET /api/app/teams/AA/board", BOARD), setup(s)));
const row = (ref: string) => document.querySelector(`[data-issue="${ref}"]`) as HTMLElement;
const refsIn = (group: string) => within(screen.getByRole("region", { name: group })).queryAllByRole("listitem").map((li) => li.getAttribute("data-issue"));
const menu = async (user: ReturnType<typeof userEvent.setup>, name: string) => {
  await user.click(screen.getByRole("button", { name }));
  return within(await screen.findByRole("dialog"));
};

describe("sub-issues in the list", () => {
  test("a sub-issue sits under its parent, indented a level for each level, and a parent shows how far along its sub-issues are", async () => {
    open();
    await screen.findByText("Epic");
    expect(refsIn("Todo")).toEqual(["AA-1", "AA-2", "AA-4", "AA-5"]);
    expect(["AA-1", "AA-2", "AA-4", "AA-5"].map((r) => row(r).getAttribute("data-depth"))).toEqual(["0", "1", "2", "0"]);
    expect(within(row("AA-1")).getByRole("img", { name: "1 of 3 sub-issues done" })).toBeTruthy(); // counts the ones in other groups too
    expect(within(row("AA-2")).getByRole("img", { name: "0 of 1 sub-issues done" })).toBeTruthy();
    expect(within(row("AA-5")).queryByRole("img")).toBeNull();
  });

  test("a sub-issue whose parent is in another group stays in its own group and names its parent", async () => {
    open();
    await screen.findByText("Epic");
    expect(refsIn("Done")).toEqual(["AA-3"]);
    expect(row("AA-3").querySelector("[data-parent-chip]")?.textContent).toContain("AA-1");
    expect(row("AA-6").querySelector("[data-parent-chip]")?.textContent).toContain("AA-1");
    expect(row("AA-2").querySelector("[data-parent-chip]")).toBeNull(); // directly under its parent
  });

  test("a parent's chevron folds its sub-issues away, and they stay away after a reload", async () => {
    const user = userEvent.setup();
    const first = open();
    await screen.findByText("Epic");
    await user.click(screen.getByRole("button", { name: "Hide the sub-issues of AA-1" }));
    expect(refsIn("Todo")).toEqual(["AA-1", "AA-5"]);
    expect(screen.getByRole("button", { name: "Show the sub-issues of AA-1" }).getAttribute("aria-expanded")).toBe("false");
    expect(row("AA-3")).not.toBeNull(); // another group: unaffected
    first.unmount();
    open();
    await screen.findByText("Epic");
    expect(refsIn("Todo")).toEqual(["AA-1", "AA-5"]);
    await user.click(screen.getByRole("button", { name: "Show the sub-issues of AA-1" }));
    expect(refsIn("Todo")).toEqual(["AA-1", "AA-2", "AA-4", "AA-5"]);
  });

  test("a parent can be folded without folding what is below its sub-issue's own parent", async () => {
    const user = userEvent.setup();
    open();
    await screen.findByText("Epic");
    await user.click(screen.getByRole("button", { name: "Hide the sub-issues of AA-2" }));
    expect(refsIn("Todo")).toEqual(["AA-1", "AA-2", "AA-5"]);
  });

  describe("the Display options", () => {
    test("'Nest under their parent' off makes every issue a row of its own, each sub-issue naming its parent", async () => {
      const user = userEvent.setup();
      open();
      await screen.findByText("Epic");
      const m = await menu(user, "Display options");
      await user.click(m.getByRole("switch", { name: "Nest sub-issues under their parent" }));
      await waitFor(() => expect(row("AA-2").getAttribute("data-depth")).toBe("0"));
      expect(refsIn("Todo")).toEqual(["AA-1", "AA-2", "AA-4", "AA-5"]);
      expect(row("AA-2").querySelector("[data-parent-chip]")?.textContent).toContain("AA-1");
      expect(row("AA-4").querySelector("[data-parent-chip]")?.textContent).toContain("AA-2");
      expect(screen.queryByRole("button", { name: /Hide the sub-issues/ })).toBeNull(); // nothing to fold
    });
    test("'Show sub-issues' off leaves only top-level issues, parents still showing their progress, and turns nesting off too", async () => {
      const user = userEvent.setup();
      open();
      await screen.findByText("Epic");
      const m = await menu(user, "Display options");
      await user.click(m.getByRole("switch", { name: "Show sub-issues" }));
      await waitFor(() => expect(refsIn("Todo")).toEqual(["AA-1", "AA-5"]));
      expect(screen.queryByRole("region", { name: "Done" })).toBeTruthy(); // statuses stay
      expect(refsIn("Done")).toEqual([]);
      expect(within(row("AA-1")).getByRole("img", { name: "1 of 3 sub-issues done" })).toBeTruthy();
      expect((m.getByRole("switch", { name: "Nest sub-issues under their parent" }) as HTMLButtonElement).disabled).toBe(true);
    });
    test("the choices are remembered for the team", async () => {
      const user = userEvent.setup();
      const first = open();
      await screen.findByText("Epic");
      const m = await menu(user, "Display options");
      await user.click(m.getByRole("switch", { name: "Show sub-issues" }));
      await waitFor(() => expect(JSON.parse(localStorage.getItem("wh:issue-view:AA")!).showSub).toBe(false));
      first.unmount();
      open();
      await screen.findByText("Epic");
      expect(refsIn("Todo")).toEqual(["AA-1", "AA-5"]);
    });
  });
});

describe("sub-issues on the board", () => {
  test("a card names its parent and a parent card shows its progress", async () => {
    localStorage.setItem("wh:layout:AA", "board");
    open();
    await screen.findByText("Epic");
    const card = (ref: string) => document.querySelector(`[data-issue="${ref}"]`) as HTMLElement;
    expect(within(card("AA-2")).getByText("↳ AA-1")).toBeTruthy();
    expect(within(card("AA-1")).getByRole("img", { name: "1 of 3 sub-issues done" })).toBeTruthy();
    expect(card("AA-5").querySelector("[data-parent-chip]")).toBeNull();
    expect(within(card("AA-5")).queryByRole("img")).toBeNull();
  });
});

describe("sub-issues in the issue dialog", () => {
  const withEpic = (extra: Parameters<typeof renderApp>[1] = () => {}) =>
    open((s) => {
      s.on("GET /api/app/issues/AA-1", detail(EPIC, { children: [kid(B, "Done", { done: true }), kid(AWAY, "Backlog"), kid(A, "Todo"), kid(D, "Canceled", { canceled: true })] }));
      s.on("GET /api/app/issues/AA-2", detail(A, { parent: kid(EPIC, "Todo"), children: [] }));
      s.on("GET /api/app/issues/AA-3", detail(B, { parent: kid(EPIC, "Todo"), children: [] }));
      s.on("GET /api/app/issues/AA-5", detail(LOOSE, { parent: null, children: [] }));
      s.on("POST /api/app/teams/AA/issues", { issue: issue({ number: 60 }) });
      s.on("PATCH /api/app/issues/AA-5", { issue: LOOSE });
      s.on("PATCH /api/app/issues/AA-2", { issue: A });
      extra(s);
    }, "/t/AA?t=AA-1");

  test("lists the sub-issues with their status, how many are done (canceled ones not counted), and each opens in place", async () => {
    const user = userEvent.setup();
    const { router } = withEpic();
    const section = within(await screen.findByRole("region", { name: "Sub-issues" }));
    expect(section.getAllByRole("listitem").map((li) => li.getAttribute("data-sub-issue"))).toEqual(["AA-3", "AA-6", "AA-2", "AA-4"]);
    expect(section.getByRole("img", { name: "1 of 3 sub-issues done" })).toBeTruthy();
    expect(within(section.getAllByRole("listitem")[0]).getByText("Done")).toBeTruthy();
    await user.click(section.getByRole("button", { name: "Task A" }));
    await waitFor(() => expect(router.state.location.search).toBe("?t=AA-2"));
  });

  test("an issue with no sub-issues offers only '+ Add sub-issue'", async () => {
    open((s) => s.on("GET /api/app/issues/AA-5", detail(LOOSE, { children: [] })), "/t/AA?t=AA-5");
    const section = within(await screen.findByRole("region", { name: "Sub-issues" }));
    expect(section.queryByRole("list")).toBeNull();
    expect(section.getByRole("button", { name: "+ Add sub-issue" })).toBeTruthy();
  });

  test("adding one creates it under this issue; Cancel or an empty title adds nothing", async () => {
    const user = userEvent.setup();
    const { server } = withEpic();
    const section = within(await screen.findByRole("region", { name: "Sub-issues" }));
    await user.click(section.getByRole("button", { name: "+ Add sub-issue" }));
    await user.type(section.getByLabelText("New sub-issue title"), "Never mind");
    await user.click(section.getByRole("button", { name: "Cancel" }));
    expect(section.queryByLabelText("New sub-issue title")).toBeNull();
    await user.click(section.getByRole("button", { name: "+ Add sub-issue" }));
    await user.type(section.getByLabelText("New sub-issue title"), "   {Enter}");
    expect(server.calls.filter((c) => c.method === "POST")).toHaveLength(0);
    await user.click(section.getByRole("button", { name: "+ Add sub-issue" }));
    await user.type(section.getByLabelText("New sub-issue title"), "  Write the tests  {Enter}");
    await waitFor(() => expect(server.sent("POST /api/app/teams/AA/issues")).toHaveLength(1));
    expect(server.sent("POST /api/app/teams/AA/issues")[0].body).toEqual({ title: "Write the tests", parent: "AA-1" });
    await waitFor(() => expect(server.sent("GET /api/app/issues/AA-1").length).toBeGreaterThan(1)); // read again, so it shows
  });

  test("a sub-issue title typed and not added counts as unsaved: closing asks first, as for a comment", async () => {
    const user = userEvent.setup();
    withEpic();
    const section = within(await screen.findByRole("region", { name: "Sub-issues" }));
    await user.click(section.getByRole("button", { name: "+ Add sub-issue" }));
    await user.type(section.getByLabelText("New sub-issue title"), "Half written");
    await user.click(screen.getByRole("button", { name: "Close issue" }));
    expect((await screen.findByRole("alertdialog")).textContent).toContain("Discard unsaved changes?");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect((section.getByLabelText("New sub-issue title") as HTMLInputElement).value).toBe("Half written"); // still there
    await user.click(section.getByRole("button", { name: "Cancel" })); // the box's own Cancel: nothing typed counts any more
    await user.click(screen.getByRole("button", { name: "Close issue" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  describe("the parent field", () => {
    const field = async () => within((await screen.findByText("Parent", { selector: "span.label" })).parentElement as HTMLElement);

    test("with a parent it shows it, opens it, and can take it away", async () => {
      const user = userEvent.setup();
      const { router } = open((s) => s.on("GET /api/app/issues/AA-2", detail(A, { parent: kid(EPIC, "Todo") })), "/t/AA?t=AA-2");
      const f = await field();
      await user.click(await f.findByRole("button", { name: /AA-1 Epic/ }));
      await waitFor(() => expect(router.state.location.search).toBe("?t=AA-1"));
    });
    test("Remove parent makes it top-level, with the version it was read at", async () => {
      const user = userEvent.setup();
      const { server } = open((s) => {
        s.on("GET /api/app/issues/AA-2", detail(A, { parent: kid(EPIC, "Todo") }));
        s.on("PATCH /api/app/issues/AA-2", { issue: A });
      }, "/t/AA?t=AA-2");
      const f = await field();
      await user.click(await f.findByRole("button", { name: "Remove parent" }));
      await waitFor(() => expect(server.sent("PATCH /api/app/issues/AA-2")).toHaveLength(1));
      expect(server.sent("PATCH /api/app/issues/AA-2")[0].body).toEqual({ parent: null, version: 1 });
    });
    test("choosing a parent for an issue with none offers the other issues, never itself, and sends the one picked", async () => {
      const user = userEvent.setup();
      const { server } = open((s) => {
        s.on("GET /api/app/issues/AA-5", detail(LOOSE, { parent: null, children: [] }));
        s.on("PATCH /api/app/issues/AA-5", { issue: LOOSE });
      }, "/t/AA?t=AA-5");
      const f = await field();
      await user.click(await f.findByRole("button", { name: "Set parent" }));
      const list = within(await screen.findByRole("list", { name: "Issues" }));
      expect(list.getAllByRole("button").map((b) => b.textContent)).toEqual(["AA-1Epic", "AA-2Task A", "AA-3Task B", "AA-4Detail", "AA-6Elsewhere"]);
      await user.type(screen.getByLabelText("Find an issue"), "task");
      expect(list.getAllByRole("button").map((b) => b.textContent)).toEqual(["AA-2Task A", "AA-3Task B"]);
      await user.type(screen.getByLabelText("Find an issue"), " zzz");
      expect(list.queryAllByRole("button")).toHaveLength(0);
      expect(screen.getByText("No issue matches.")).toBeTruthy();
      await user.clear(screen.getByLabelText("Find an issue"));
      await user.type(screen.getByLabelText("Find an issue"), "task a");
      await user.click(list.getByRole("button", { name: /AA-2/ }));
      await waitFor(() => expect(server.sent("PATCH /api/app/issues/AA-5")).toHaveLength(1));
      expect(server.sent("PATCH /api/app/issues/AA-5")[0].body).toEqual({ parent: "AA-2", version: 1 });
    });
    test("an issue is never offered something below it as its parent (that would be a loop)", async () => {
      const user = userEvent.setup();
      open((s) => s.on("GET /api/app/issues/AA-1", detail(EPIC, { parent: null, children: [kid(A, "Todo")] })), "/t/AA?t=AA-1");
      const f = await field();
      await user.click(await f.findByRole("button", { name: "Set parent" }));
      const list = within(await screen.findByRole("list", { name: "Issues" }));
      // below AA-1: AA-2, AA-3, AA-6 (its sub-issues) and AA-4 (under AA-2)
      expect(list.getAllByRole("button").map((b) => b.textContent)).toEqual(["AA-5Loose"]);
    });
  });

  test("deleting an issue with sub-issues says they stay, as top-level issues", async () => {
    const user = userEvent.setup();
    withEpic((s) => s.on("DELETE /api/app/issues/AA-1", { ok: true }));
    await screen.findByRole("region", { name: "Sub-issues" });
    await user.click(await screen.findByRole("button", { name: "Delete issue" }));
    expect((await screen.findByRole("alertdialog")).textContent).toContain("Its 4 sub-issues stay, as top-level issues.");
  });
});
