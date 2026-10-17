import { describe, expect, test } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { apiError, liveBoard, renderApp } from "../../test/harness";
import { board as makeBoard, ticket } from "../../test/data";
import { FakeEventSource } from "../../test/fake-event-source";

const column = (name: string) => screen.getByText(name, { selector: ".text-sm.font-medium" }).closest("[data-column]") as HTMLElement;
const open = async (path = "/p/AA") => {
  const r = renderApp(path);
  await screen.findByText("Write the plan");
  return r;
};

describe("the board", () => {
  test("shows the project's five columns with their cards, counts and the project header", async () => {
    await open();
    expect(screen.getByRole("heading", { level: 1, name: "Alpha" })).toBeTruthy();
    for (const [name, count] of [["Backlog", 1], ["Todo", 2], ["In Progress", 0], ["Review", 0], ["Done", 1]] as const) {
      const col = column(name);
      expect(within(col).getAllByText(String(count)).length).toBeGreaterThan(0);
      expect(col.querySelectorAll("[data-ticket]")).toHaveLength(count);
    }
    expect(within(column("Todo")).getByText("Build the board")).toBeTruthy();
  });

  test("a card shows its ref, priority, labels, AI state, who made it and its comments, and only what is not ordinary", async () => {
    await open();
    const plan = screen.getByText("Write the plan").closest("[data-ticket]") as HTMLElement;
    expect(within(plan).getByText("AA-1")).toBeTruthy();
    expect(within(plan).getByText("high")).toBeTruthy();
    expect(within(plan).getByText("docs")).toBeTruthy();
    const build = screen.getByText("Build the board").closest("[data-ticket]") as HTMLElement;
    expect(within(build).queryByText("medium")).toBeNull(); // the usual priority is not shown
    expect(within(build).getByText("AI-ready")).toBeTruthy();
    const crash = screen.getByText("Fix the crash").closest("[data-ticket]") as HTMLElement;
    expect(within(crash).getByTitle("Created by an agent")).toBeTruthy();
    expect(within(crash).getByText("2")).toBeTruthy();
  });

  test("a claimed ticket says an agent is working on it, and a linked one names its map node", async () => {
    renderApp("/p/AA", (s) =>
      liveBoard(s, "AA", makeBoard("AA", { tickets: [ticket({ number: 7, title: "Claimed", agentClaimable: true, claimedByKeyId: "k1", nodeIds: ["n-api"] })] })),
    );
    const card = (await screen.findByText("Claimed")).closest("[data-ticket]") as HTMLElement;
    expect(within(card).getByText("agent working")).toBeTruthy();
    expect(within(card).getByText("API")).toBeTruthy();
  });

  test("the setup checklist is above it: a one-line pill when everything is set up", async () => {
    await open();
    expect(screen.getByRole("button", { name: /Setup complete/ })).toBeTruthy();
  });

  test("while the board loads there is a busy skeleton; if it cannot load there is a message with Try again", async () => {
    let release!: () => void;
    const first = renderApp("/p/AA", (s) => {
      let held = true;
      s.on("GET /api/app/projects/AA/board", async () => {
        if (held) await new Promise<void>((r) => (release = r));
        held = false;
        return makeBoard("AA");
      });
    });
    expect((await screen.findByText("Loading the board…")).closest("[role=status]")?.getAttribute("aria-busy")).toBe("true");
    await waitFor(() => expect(release).toBeTypeOf("function"));
    release();
    await screen.findByText("Write the plan");
    first.unmount();

    let healthy = false;
    const failing = renderApp("/p/BB", (s) => s.on("GET /api/app/projects/BB/board", () => (healthy ? makeBoard("BB") : apiError(500, "internal", "Internal error"))));
    expect(failing).toBeTruthy();
    const alert = await screen.findByRole("alert", {}, { timeout: 8000 });
    expect(alert.textContent).toContain("Internal error");
    healthy = true;
    await userEvent.setup().click(within(alert).getByRole("button", { name: "Try again" }));
    await screen.findByText("Write the plan");
  }, 20_000);
});

describe("adding a ticket", () => {
  const withCreate = (s: Parameters<Parameters<typeof renderApp>[1] & object>[0]) => {
    const live = liveBoard(s, "AA", makeBoard("AA"));
    s.on("POST /api/app/projects/AA/tickets", ({ body }) => {
      const b = body as { title: string; column: string };
      const created = ticket({ number: 50, title: b.title, columnId: b.column });
      live.board = { ...live.board, tickets: [...live.board.tickets, created] };
      return Response.json({ ticket: { ...created, column: "x" } }, { status: 201 });
    });
    return live;
  };

  test("+ Add ticket opens a box; Enter adds it to that column and keeps the box open for the next one", async () => {
    const { server } = renderApp("/p/AA", (s) => void withCreate(s));
    await screen.findByText("Write the plan");
    const user = userEvent.setup();
    await user.click(within(column("Todo")).getByRole("button", { name: "+ Add ticket" }));
    const box = within(column("Todo")).getByLabelText("New ticket in Todo");
    await user.type(box, "A new one{Enter}");
    await waitFor(() => expect(server.sent("POST /api/app/projects/AA/tickets")).toHaveLength(1));
    expect(server.sent("POST /api/app/projects/AA/tickets")[0].body).toEqual({ title: "A new one", column: "c-todo" });
    await within(column("Todo")).findByText("A new one");
    expect((within(column("Todo")).getByLabelText("New ticket in Todo") as HTMLTextAreaElement).value).toBe("");
    await user.type(within(column("Todo")).getByLabelText("New ticket in Todo"), "And another{Enter}");
    await waitFor(() => expect(server.sent("POST /api/app/projects/AA/tickets")).toHaveLength(2));
  });

  test("Escape throws the text away without adding anything, and an empty box adds nothing", async () => {
    const { server } = renderApp("/p/AA", (s) => void withCreate(s));
    await screen.findByText("Write the plan");
    const user = userEvent.setup();
    await user.click(within(column("Todo")).getByRole("button", { name: "+ Add ticket" }));
    await user.type(within(column("Todo")).getByLabelText("New ticket in Todo"), "Never mind{Escape}");
    expect(within(column("Todo")).getByRole("button", { name: "+ Add ticket" })).toBeTruthy();
    await user.click(within(column("Done")).getByRole("button", { name: "+ Add ticket" }));
    await user.click(document.body); // leaves an empty box
    expect(server.sent("POST /api/app/projects/AA/tickets")).toHaveLength(0);
  });

  test("leaving the box with text in it adds the ticket, once", async () => {
    const { server } = renderApp("/p/AA", (s) => void withCreate(s));
    await screen.findByText("Write the plan");
    const user = userEvent.setup();
    await user.click(within(column("Backlog")).getByRole("button", { name: "+ Add ticket" }));
    await user.type(within(column("Backlog")).getByLabelText("New ticket in Backlog"), "Typed then left");
    await user.click(document.body);
    await within(column("Backlog")).findByText("Typed then left");
    expect(server.sent("POST /api/app/projects/AA/tickets")).toHaveLength(1);
  });

  test("a column filter does not hide the ticket just added, so the add does not look like it failed", async () => {
    localStorage.setItem("wh:view:AA:c-todo", JSON.stringify({ priority: ["urgent"] }));
    renderApp("/p/AA", (s) => void withCreate(s));
    await screen.findByText("Write the plan");
    await waitFor(() => expect(within(column("Todo")).getByText("0 of 2")).toBeTruthy());
    const user = userEvent.setup();
    await user.click(within(column("Todo")).getByRole("button", { name: "+ Add ticket" }));
    await user.type(within(column("Todo")).getByLabelText("New ticket in Todo"), "Medium one{Enter}");
    await within(column("Todo")).findByText("Medium one"); // a medium ticket in a column filtered to urgent
    expect(within(column("Todo")).queryByText("Build the board")).toBeNull(); // the others stay filtered out
  });
});

describe("filter and sort", () => {
  test("a column's sort is applied, announced, remembered, and comes back after a reload", async () => {
    localStorage.setItem("wh:view:AA:c-todo", JSON.stringify({ sort: { key: "title", dir: "desc" } }));
    const { unmount } = renderApp("/p/AA");
    await screen.findByText("Write the plan");
    const todo = column("Todo");
    await waitFor(() => expect(within(todo).getByText("sorted by Title ↓; drag order is off")).toBeTruthy());
    expect([...todo.querySelectorAll("[data-ticket]")].map((e) => e.getAttribute("data-ticket"))).toEqual(["AA-3", "AA-2"]); // "Fix the crash" before "Build the board": Title, descending
    unmount();
    renderApp("/p/AA");
    await screen.findByText("Write the plan");
    await waitFor(() => expect(within(column("Todo")).getByText("sorted by Title ↓; drag order is off")).toBeTruthy());
    expect(within(column("Backlog")).queryByText(/sorted by/)).toBeNull(); // only that column
  });

  test("a filter hides non-matching cards, says how many are shown, and survives a reload", async () => {
    localStorage.setItem("wh:view:AA:c-todo", JSON.stringify({ flags: ["byAgent"] }));
    const { unmount } = renderApp("/p/AA");
    await screen.findByText("Fix the crash");
    await waitFor(() => expect(within(column("Todo")).queryByText("Build the board")).toBeNull());
    expect(within(column("Todo")).getByText("1 of 2")).toBeTruthy();
    unmount();
    renderApp("/p/AA");
    await screen.findByText("Fix the crash");
    await waitFor(() => expect(within(column("Todo")).queryByText("Build the board")).toBeNull());
  });

  test("the filter menu: ticking a priority filters, ✕ clears it, and it is saved", async () => {
    renderApp("/p/AA");
    await screen.findByText("Write the plan");
    const user = userEvent.setup();
    const head = column("Backlog");
    await user.click(within(head).getByRole("button", { name: "Filter" }));
    await user.click(await screen.findByRole("menuitemcheckbox", { name: "Urgent" }));
    await waitFor(() => expect(within(head).queryByText("Write the plan")).toBeNull());
    expect(JSON.parse(localStorage.getItem("wh:view:AA:c-backlog")!)).toMatchObject({ priority: ["urgent"] });
    await user.keyboard("{Escape}");
    await user.click(within(head).getByRole("button", { name: "Clear filter" }));
    await within(head).findByText("Write the plan");
    expect(localStorage.getItem("wh:view:AA:c-backlog")).toBeNull();
  });

  test("the sort menu: choosing Title sorts, 'Manual' goes back to drag order", async () => {
    renderApp("/p/AA");
    await screen.findByText("Write the plan");
    const user = userEvent.setup();
    const head = column("Todo");
    await user.click(within(head).getByRole("button", { name: "Sort" }));
    await user.click(await screen.findByRole("menuitemradio", { name: "Title" }));
    await waitFor(() => expect(within(head).getByText(/sorted by Title ↑/)).toBeTruthy());
    await user.keyboard("{Escape}");
    await user.click(within(head).getByRole("button", { name: /Sort: Title/ }));
    await user.click(await screen.findByRole("menuitemradio", { name: "Manual (drag order)" }));
    await waitFor(() => expect(within(head).queryByText(/sorted by/)).toBeNull());
  });
});

describe("live updates", () => {
  test("a change by an agent (a card moved, one added) appears when the stream says so, with no duplicates", async () => {
    let live!: ReturnType<typeof liveBoard>;
    renderApp("/p/AA", (s) => (live = liveBoard(s, "AA", makeBoard("AA"))));
    await screen.findByText("Write the plan");
    await waitFor(() => expect(FakeEventSource.open.length).toBe(1));
    const cardsBefore = document.querySelectorAll("[data-ticket]").length;
    live.board = {
      ...live.board,
      tickets: [
        ...live.board.tickets.map((t) => (t.ref === "AA-2" ? { ...t, columnId: "c-review", version: 2 } : t)),
        ticket({ number: 60, title: "Added by an agent", columnId: "c-progress", createdByKind: "agent" }),
      ],
    };
    const started = Date.now();
    act(() => FakeEventSource.open[0].emit("change", { seq: 9 }));
    await within(column("Review")).findByText("Build the board");
    await within(column("In Progress")).findByText("Added by an agent");
    expect(Date.now() - started).toBeLessThan(1000);
    expect(within(column("Todo")).queryByText("Build the board")).toBeNull();
    expect(document.querySelectorAll("[data-ticket]").length).toBe(cardsBefore + 1);
    expect(screen.getAllByText("Build the board")).toHaveLength(1);
  });

  test("a change made by someone else while a ticket is open does not close it or lose the page", async () => {
    let live!: ReturnType<typeof liveBoard>;
    renderApp("/p/AA?t=AA-2", (s) => {
      live = liveBoard(s, "AA", makeBoard("AA"));
    });
    await screen.findByRole("dialog");
    live.board = { ...live.board, tickets: live.board.tickets.filter((t) => t.ref !== "AA-1") };
    act(() => FakeEventSource.open[0]?.emit("change", { seq: 3 }));
    await waitFor(() => expect(screen.queryByText("Write the plan")).toBeNull());
    expect(screen.getByRole("dialog")).toBeTruthy();
  });
});
