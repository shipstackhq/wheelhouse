import { beforeEach, describe, expect, test, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { act } from "react";
import { renderApp } from "../../test/harness";
import { board, issue } from "../../test/data";

// jsdom has no layout, so a drag cannot be performed. The board gives its DndContext handlers; these tests take them and report a drag
// the way dnd-kit would (picked up, carried over a card or column, released), to check what the board then tells the server.
const dnd = vi.hoisted(() => ({} as { start?: (e: unknown) => void; over?: (e: unknown) => void; end?: (e: unknown) => void }));
vi.mock("@dnd-kit/core", async (original) => {
  const real = await original<typeof import("@dnd-kit/core")>();
  return {
    ...real,
    DndContext: (props: { id?: string; onDragStart?: (e: unknown) => void; onDragOver?: (e: unknown) => void; onDragEnd?: (e: unknown) => void; children: React.ReactNode }) => {
      if (props.id === "board-dnd") Object.assign(dnd, { start: props.onDragStart, over: props.onDragOver, end: props.onDragEnd });
      return props.children;
    },
  };
});

const CYCLES = [{ number: 2, name: "", startsAt: "2026-10-01T00:00:00.000Z", endsAt: "2026-10-14T00:00:00.000Z", state: "current" as const }];
const DATA = board("AA", {
  cycles: CYCLES,
  issues: [
    issue({ number: 1, title: "One", statusId: "c-todo", priority: "high", assigneeId: "u1", position: 1, version: 3 }),
    issue({ number: 2, title: "Two", statusId: "c-todo", priority: "high", assigneeId: null, position: 2 }),
    issue({ number: 3, title: "Three", statusId: "c-review", priority: "urgent", assigneeId: "u2", position: 1 }),
  ],
});

const view = (v: object) => localStorage.setItem("wh:issue-view:AA", JSON.stringify(v));
const open = (setup: Parameters<typeof renderApp>[1] = () => {}) => {
  localStorage.setItem("wh:layout:AA", "board");
  return renderApp("/t/AA", (s) => {
    s.on("GET /api/app/teams/AA/board", DATA);
    s.on("PATCH /api/app/issues/AA-1", { issue: issue({ number: 1 }) });
    s.on("POST /api/app/issues/AA-1/move", { issue: issue({ number: 1 }) });
    s.on("POST /api/app/teams/AA/issues", { issue: issue({ number: 50 }) });
    setup(s);
  });
};
/** Pick the card up, carry it over `over` (a card's id or a column's id) and let go. */
const drag = async (id: string, over: string | null) => {
  await act(async () => dnd.start?.({ active: { id } }));
  if (over) await act(async () => dnd.over?.({ active: { id }, over: { id: over } }));
  await act(async () => dnd.end?.({ active: { id }, over: over ? { id: over } : null }));
};
const sent = (server: { calls: { method: string }[] }) => server.calls.filter((c) => c.method !== "GET");

beforeEach(() => {
  for (const k of Object.keys(dnd)) delete (dnd as Record<string, unknown>)[k];
});

describe("a board grouped by something other than status", () => {
  test("a card dropped in another priority's column gets that priority, with the version it was read at", async () => {
    view({ groupBy: "priority" });
    const { server } = open();
    await screen.findByText("One");
    await drag("t-1", "priority:urgent");
    await waitFor(() => expect(server.sent("PATCH /api/app/issues/AA-1")).toHaveLength(1));
    expect(server.sent("PATCH /api/app/issues/AA-1")[0].body).toEqual({ priority: "urgent", version: 3 });
    await waitFor(() => expect(server.sent("GET /api/app/teams/AA/board").length).toBeGreaterThan(1)); // the server's answer replaces the board
  });

  test("by assignee: into a person's column gives them the issue, into Unassigned gives it to nobody", async () => {
    view({ groupBy: "assignee" });
    const { server } = open();
    await screen.findByText("One");
    await drag("t-1", "assignee:u2");
    await waitFor(() => expect(server.sent("PATCH /api/app/issues/AA-1")).toHaveLength(1));
    expect(server.sent("PATCH /api/app/issues/AA-1")[0].body).toEqual({ assigneeId: "u2", version: 3 });
    await drag("t-1", "assignee:none");
    await waitFor(() => expect(server.sent("PATCH /api/app/issues/AA-1")).toHaveLength(2));
    expect(server.sent("PATCH /api/app/issues/AA-1")[1].body).toEqual({ assigneeId: null, version: 3 });
  });

  test("every column is there to drop into, even one with nothing in it", async () => {
    view({ groupBy: "priority" });
    const { server } = open();
    await screen.findByText("One");
    expect([...document.querySelectorAll("[data-column]")].map((c) => c.getAttribute("data-column"))).toEqual(["priority:urgent", "priority:high", "priority:medium", "priority:low", "priority:none"]);
    await drag("t-1", "priority:low"); // nothing is low
    await waitFor(() => expect(server.sent("PATCH /api/app/issues/AA-1")).toHaveLength(1));
    expect(server.sent("PATCH /api/app/issues/AA-1")[0].body).toEqual({ priority: "low", version: 3 });
  });

  test("by cycle: into a cycle's column sets it, into 'No cycle' clears it", async () => {
    view({ groupBy: "cycle" });
    const { server } = open((s) => s.on("GET /api/app/teams/AA/board", board("AA", { cycles: CYCLES, issues: [issue({ number: 1, title: "One", cycle: 2, version: 3 }), issue({ number: 2, title: "Two", cycle: null })] })));
    await screen.findByText("One");
    await drag("t-1", "cycle:none");
    await waitFor(() => expect(server.sent("PATCH /api/app/issues/AA-1")).toHaveLength(1));
    expect(server.sent("PATCH /api/app/issues/AA-1")[0].body).toEqual({ cycle: null, version: 3 });
    await drag("t-2", "cycle:2");
    await waitFor(() => expect(server.sent("PATCH /api/app/issues/AA-2")).toHaveLength(1));
  });

  test("moving a card inside its own column changes nothing (their order is not manual), and a drop outside any column sends nothing", async () => {
    view({ groupBy: "priority" });
    const { server } = open();
    await screen.findByText("One");
    await drag("t-1", "t-2"); // same priority column
    await drag("t-1", null);
    expect(sent(server)).toHaveLength(0);
  });

  test("a card is shown in its new column at once, before the server has answered", async () => {
    view({ groupBy: "priority" });
    open((s) => s.on("PATCH /api/app/issues/AA-1", () => new Promise(() => {}))); // never answers
    await screen.findByText("One");
    await drag("t-1", "priority:urgent");
    const urgent = document.querySelector('[data-column="priority:urgent"]') as HTMLElement;
    expect(within(urgent).getByText("One")).toBeTruthy();
    expect(within(document.querySelector('[data-column="priority:high"]') as HTMLElement).queryByText("One")).toBeNull();
  });

  test("'+ Add issue' in a column creates an issue that starts with what the column is", async () => {
    view({ groupBy: "priority" });
    const user = userEvent.setup();
    const { server } = open();
    await screen.findByText("One");
    await user.click(within(document.querySelector('[data-column="priority:urgent"]') as HTMLElement).getByRole("button", { name: "+ Add issue" }));
    await user.type(screen.getByLabelText("New issue in Urgent"), "From urgent{Enter}");
    await waitFor(() => expect(server.sent("POST /api/app/teams/AA/issues")).toHaveLength(1));
    expect(server.sent("POST /api/app/teams/AA/issues")[0].body).toEqual({ title: "From urgent", priority: "urgent" });
  });

  test("with no grouping the board is one column and a drag changes nothing", async () => {
    view({ groupBy: "none" });
    const { server } = open();
    await screen.findByText("One");
    expect([...document.querySelectorAll("[data-column]")].map((c) => c.getAttribute("data-column"))).toEqual(["none:all"]);
    await drag("t-1", "t-2");
    expect(sent(server)).toHaveLength(0);
  });
});

describe("a board grouped by status", () => {
  test("a card dropped in another status's column is moved by that status's id, at the place it was dropped", async () => {
    const { server } = open();
    await screen.findByText("One");
    await drag("t-1", "t-3"); // over Three, in Review
    await waitFor(() => expect(server.sent("POST /api/app/issues/AA-1/move")).toHaveLength(1));
    expect(server.sent("POST /api/app/issues/AA-1/move")[0].body).toEqual({ status: "c-review", index: 1 });
  });
  test("with an order that is not manual, a card can still change status but its place is not saved within a column", async () => {
    view({ groupBy: "status", sort: { key: "title", dir: "asc" } });
    const { server } = open();
    await screen.findByText("One");
    await drag("t-1", "t-2"); // same column: its order is the sort's
    expect(sent(server)).toHaveLength(0);
    await drag("t-1", "t-3"); // another status: still a move
    await waitFor(() => expect(server.sent("POST /api/app/issues/AA-1/move")).toHaveLength(1));
  });
});
