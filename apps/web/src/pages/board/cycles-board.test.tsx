import { describe, expect, test } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { CycleOption } from "@wheelhouse/api-client";
import { renderApp, type FakeServer } from "../../test/harness";
import { board as makeBoard, detail, ticket } from "../../test/data";

const DAY = 86_400_000;
const at = (n: number) => new Date(Date.now() + n * DAY).toISOString();
const CYCLES: CycleOption[] = [
  { number: 3, name: "", startsAt: at(5), endsAt: at(12), state: "upcoming" },
  { number: 2, name: "Spring", startsAt: at(-2), endsAt: at(5), state: "current" },
  { number: 1, name: "Kick-off", startsAt: at(-16), endsAt: at(-2), state: "past" },
];
const withCycles = () =>
  makeBoard("AA", {
    cycles: CYCLES,
    tickets: [
      ticket({ number: 1, title: "Write the plan", columnId: "c-backlog" }),
      ticket({ number: 2, title: "Build the board", columnId: "c-todo", cycle: 2 }),
      ticket({ number: 3, title: "Fix the crash", columnId: "c-todo", cycle: 3 }),
      ticket({ number: 4, title: "Ship it", columnId: "c-done", cycle: 1 }),
    ],
  });
const column = (name: string) => screen.getByText(name, { selector: ".text-sm.font-medium" }).closest("[data-column]") as HTMLElement;
const open = async (path = "/t/AA", setup: (s: FakeServer) => unknown = () => {}) => {
  const r = renderApp(path, (s) => {
    s.on("GET /api/app/teams/AA/board", withCycles());
    setup(s);
  });
  await screen.findByText("Build the board");
  return r;
};

describe("cycles on the board", () => {
  test("a card in a cycle carries a chip with its number and the cycle's name on hover; a card in none has no chip", async () => {
    await open();
    const chip = (title: string) => (screen.getByText(title).closest("[data-ticket]") as HTMLElement).querySelector("[data-cycle-chip]") as HTMLElement | null;
    expect(chip("Build the board")!.textContent).toBe(" 2");
    expect(chip("Build the board")!.getAttribute("title")).toBe("Cycle 2: Spring");
    expect(chip("Fix the crash")!.getAttribute("title")).toBe("Cycle 3");
    expect(chip("Ship it")!.getAttribute("title")).toBe("Cycle 1: Kick-off");
    expect(chip("Write the plan")).toBeNull();
  });

  test("the column's filter menu has a Cycle section; ticking a cycle narrows the column and is remembered", async () => {
    await open();
    const user = userEvent.setup();
    const todo = column("Todo");
    await user.click(within(todo).getByRole("button", { name: "Filter" }));
    expect(await screen.findByRole("menuitemcheckbox", { name: "No cycle" })).toBeTruthy();
    await user.click(screen.getByRole("menuitemcheckbox", { name: /Cycle 2: Spring/ }));
    await waitFor(() => expect(within(todo).queryByText("Fix the crash")).toBeNull());
    expect(within(todo).getByText("Build the board")).toBeTruthy();
    expect(within(todo).getByText("1 of 2")).toBeTruthy();
    expect(JSON.parse(localStorage.getItem("wh:view:AA:c-todo")!)).toMatchObject({ cycle: ["2"] });
    await user.keyboard("{Escape}");
    expect(within(todo).getByRole("button", { name: /Filter: Cycle 2/ })).toBeTruthy();
  });

  test("'No cycle' shows only tickets in none, and two cycles together show either", async () => {
    // Todo holds two tickets, both in a cycle: "No cycle" leaves it empty. (Another column is the one to wait for: the filter hides these.)
    const show = async () => {
      const r = renderApp("/t/AA", (s) => s.on("GET /api/app/teams/AA/board", withCycles()));
      await screen.findByText("Write the plan");
      return r;
    };
    localStorage.setItem("wh:view:AA:c-todo", JSON.stringify({ cycle: ["none"] }));
    const { unmount } = await show();
    const todo = column("Todo");
    await waitFor(() => expect(within(todo).getByText("0 of 2")).toBeTruthy());
    expect(todo.querySelectorAll("[data-ticket]")).toHaveLength(0);
    unmount();
    localStorage.setItem("wh:view:AA:c-todo", JSON.stringify({ cycle: ["2", "3"] }));
    await show();
    expect(column("Todo").querySelectorAll("[data-ticket]")).toHaveLength(2);
  });

  test("a view saved before cycles existed still loads and filters", async () => {
    localStorage.setItem("wh:view:AA:c-todo", JSON.stringify({ priority: ["medium"], flags: [], sort: null })); // no `cycle` key
    await open();
    await waitFor(() => expect(within(column("Todo")).getByText("Build the board")).toBeTruthy());
    expect(column("Todo").querySelectorAll("[data-ticket]").length).toBeGreaterThan(0);
  });

  test("with no cycles the filter menu has no Cycle section and cards have no chip", async () => {
    renderApp("/t/AA");
    await screen.findByText("Write the plan");
    expect(document.querySelectorAll("[data-cycle-chip]")).toHaveLength(0);
    await userEvent.setup().click(within(column("Backlog")).getByRole("button", { name: "Filter" }));
    await screen.findByRole("menuitemcheckbox", { name: "Urgent" });
    expect(screen.queryByRole("menuitemcheckbox", { name: "No cycle" })).toBeNull();
  });
});

describe("the Cycle field of a ticket", () => {
  const T = () => withCycles().tickets.find((t) => t.ref === "AA-2")!; // in cycle 2
  const pick = async (user: ReturnType<typeof userEvent.setup>, d: HTMLElement, option: string) => {
    const field = within(d).getByText("Cycle", { selector: "span.label" }).parentElement as HTMLElement;
    await user.click(within(field).getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: option }));
  };
  const openTicket = async (ticketOver: Partial<ReturnType<typeof T>> = {}) => {
    const r = await open("/t/AA?t=AA-2", (s) => {
      s.on("GET /api/app/tickets/AA-2", detail({ ...T(), ...ticketOver }));
      s.on("PATCH /api/app/tickets/AA-2", { ticket: T() });
    });
    const d = await screen.findByRole("dialog");
    await within(d).findByRole("textbox", { name: "Title" });
    return { ...r, d };
  };

  test("it shows the ticket's cycle, offers the ones still open to it (not a past one) and no cycle", async () => {
    const { d } = await openTicket();
    const field = within(d).getByText("Cycle", { selector: "span.label" }).parentElement as HTMLElement;
    expect(within(field).getByRole("combobox").textContent).toContain("Cycle 2: Spring");
    await userEvent.setup().click(within(field).getByRole("combobox"));
    const options = (await screen.findAllByRole("option")).map((o) => o.textContent);
    expect(options).toEqual(["No cycle", "Cycle 3", "Cycle 2: Spring"]);
  });

  test("a ticket still in a cycle that has ended shows it, so the field is not blank", async () => {
    const { d } = await openTicket({ cycle: 1 });
    const field = within(d).getByText("Cycle", { selector: "span.label" }).parentElement as HTMLElement;
    expect(within(field).getByRole("combobox").textContent).toContain("Cycle 1: Kick-off");
    await userEvent.setup().click(within(field).getByRole("combobox"));
    expect((await screen.findAllByRole("option")).map((o) => o.textContent)).toEqual(["No cycle", "Cycle 3", "Cycle 2: Spring", "Cycle 1: Kick-off"]);
  });

  test("choosing a cycle saves its number with the ticket's version, and No cycle saves null", async () => {
    const { server, d } = await openTicket();
    const user = userEvent.setup();
    await pick(user, d, "Cycle 3");
    await waitFor(() => expect(server.sent("PATCH /api/app/tickets/AA-2")).toHaveLength(1));
    expect(server.sent("PATCH /api/app/tickets/AA-2")[0].body).toEqual({ cycle: 3, version: 1 });
    await pick(user, d, "No cycle");
    await waitFor(() => expect(server.sent("PATCH /api/app/tickets/AA-2")).toHaveLength(2));
    expect(server.sent("PATCH /api/app/tickets/AA-2")[1].body).toEqual({ cycle: null, version: 1 });
  });

  test("a team with no cycles, and a ticket in none, does not show the field", async () => {
    renderApp("/t/AA?t=AA-2", (s) => s.on("GET /api/app/tickets/AA-2", detail(ticket({ number: 2, title: "Build the board", columnId: "c-todo" }))));
    const d = await screen.findByRole("dialog");
    await within(d).findByRole("textbox", { name: "Title" });
    expect(within(d).queryByText("Cycle", { selector: "span.label" })).toBeNull();
  });
});
