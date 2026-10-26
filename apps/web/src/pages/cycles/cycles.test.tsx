import { describe, expect, test } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { apiError, renderApp } from "../../test/harness";
import { cycleDetail, cycleSummary } from "../../test/data";

const DAY = 86_400_000;
const days = (n: number) => new Date(Date.now() + n * DAY).toISOString();
const open = (path = "/t/AA/cycles", setup: Parameters<typeof renderApp>[1] = () => {}) => renderApp(path, setup);
const LIST = (over = {}) => ({ current: null, upcoming: [], past: [], ...over });

describe("the cycles page", () => {
  test("the current cycle, the ones coming and the ones behind, each with its goal, dates, timing and how much is done", async () => {
    open("/t/AA/cycles", (s) =>
      s.on(
        "GET /api/app/teams/AA/cycles",
        LIST({
          current: cycleSummary({ number: 3, name: "Spring", goal: "Ship billing", total: 4, done: 1, open: 3 }),
          upcoming: [cycleSummary({ number: 4, state: "upcoming", startsAt: days(5), endsAt: days(12) })],
          past: [cycleSummary({ number: 2, state: "past", startsAt: days(-16), endsAt: days(-2), total: 3, done: 3 }), cycleSummary({ number: 1, state: "past", startsAt: days(-30), endsAt: days(-16), name: "Kick-off" })],
        }),
      ),
    );
    const current = await screen.findByRole("region", { name: "Current cycle" });
    expect(within(current).getByText("Cycle 3: Spring")).toBeTruthy();
    expect(within(current).getByText("current", { selector: ".chip" })).toBeTruthy();
    expect(within(current).getByText("Ship billing")).toBeTruthy();
    expect(current.textContent).toMatch(/ends in \d+ days?/);
    expect(within(current).getByLabelText("1 of 4 issues done")).toBeTruthy();
    const upcoming = screen.getByRole("region", { name: "Upcoming cycles" });
    expect(within(upcoming).getByText("Cycle 4")).toBeTruthy();
    expect(upcoming.textContent).toMatch(/starts in \d+ days?/);
    const past = screen.getByRole("region", { name: "Past cycles" });
    expect(within(past).getAllByRole("link").map((a) => a.textContent?.split("past")[0])).toEqual(["Cycle 2", "Cycle 1: Kick-off"]);
    expect(within(past).getByLabelText("3 of 3 issues done")).toBeTruthy();
    expect(within(current).getByRole("link").getAttribute("href")).toBe("/w/ae/t/AA/cycles/3");
  });

  test("with none it says cycles are optional; there is a button to start one", async () => {
    open("/t/AA/cycles", (s) => s.on("GET /api/app/teams/AA/cycles", LIST()));
    await screen.findByText(/No cycles yet/);
    expect(screen.queryByRole("region", { name: "Current cycle" })).toBeNull();
    expect(screen.getByRole("button", { name: "+ New cycle" })).toBeTruthy();
  });

  test("a new cycle is made from a name, a goal, a start day and a length, and the list is read again", async () => {
    let made = false;
    const { server } = open("/t/AA/cycles", (s) => {
      s.on("GET /api/app/teams/AA/cycles", () => (made ? LIST({ current: cycleSummary({ number: 1, name: "First" }) }) : LIST()));
      s.on("POST /api/app/teams/AA/cycles", () => {
        made = true;
        return new Response(JSON.stringify({ cycle: cycleSummary({ number: 1, name: "First" }) }), { status: 201, headers: { "content-type": "application/json" } });
      });
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "+ New cycle" }));
    await user.type(screen.getByRole("textbox", { name: "Name" }), "First");
    await user.type(screen.getByRole("textbox", { name: "Goal" }), "Get going");
    const length = screen.getByLabelText(/Lasts/);
    await user.clear(length);
    await user.type(length, "7");
    await user.click(screen.getByRole("button", { name: "Start the cycle" }));
    await waitFor(() => expect(server.sent("POST /api/app/teams/AA/cycles")).toHaveLength(1));
    const body = server.sent("POST /api/app/teams/AA/cycles")[0].body as { name: string; goal: string; startsAt: string; endsAt: string };
    expect([body.name, body.goal]).toEqual(["First", "Get going"]);
    expect(new Date(body.endsAt).getTime() - new Date(body.startsAt).getTime()).toBeGreaterThanOrEqual(7 * DAY - 3_600_000); // seven days (an hour of slack for a clock change)
    expect(new Date(body.endsAt).getTime() - new Date(body.startsAt).getTime()).toBeLessThanOrEqual(7 * DAY + 3_600_000);
    expect(new Date(body.startsAt).getHours() + new Date(body.startsAt).getMinutes()).toBe(0); // it starts at the start of that day, here
    await screen.findByText("Cycle 1: First");
    expect(screen.queryByRole("textbox", { name: "Name" })).toBeNull();
  });

  test("a refusal (an overlap) is shown in the form and nothing is closed", async () => {
    open("/t/AA/cycles", (s) => {
      s.on("GET /api/app/teams/AA/cycles", LIST());
      s.on("POST /api/app/teams/AA/cycles", apiError(409, "conflict", "That overlaps Cycle 1 (2026-10-19 to 2026-11-02). Cycles of a team do not overlap."));
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "+ New cycle" }));
    await user.click(screen.getByRole("button", { name: "Start the cycle" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/overlaps Cycle 1/);
    expect(screen.getByRole("textbox", { name: "Name" })).toBeTruthy();
  });

  test("a length outside one to fourteen days cannot be submitted", async () => {
    open("/t/AA/cycles", (s) => s.on("GET /api/app/teams/AA/cycles", LIST()));
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "+ New cycle" }));
    const length = screen.getByLabelText(/Lasts/);
    for (const bad of ["0", "15", ""]) {
      await user.clear(length);
      if (bad) await user.type(length, bad);
      expect((screen.getByRole("button", { name: "Start the cycle" }) as HTMLButtonElement).disabled, `"${bad}"`).toBe(true);
    }
    await user.clear(length);
    await user.type(length, "14");
    expect((screen.getByRole("button", { name: "Start the cycle" }) as HTMLButtonElement).disabled).toBe(false);
  });

  test("the sidebar has a Cycles link for the team", async () => {
    open("/t/AA/cycles", (s) => s.on("GET /api/app/teams/AA/cycles", LIST()));
    await screen.findByText(/No cycles yet/);
    const link = screen.getAllByRole("link", { name: "Cycles" }).find((a) => a.getAttribute("href") === "/w/ae/t/AA/cycles");
    expect(link).toBeTruthy();
  });

  test("a team of another workspace is not found", async () => {
    open("/t/ZZ/cycles", (s) => s.on("GET /api/app/teams/ZZ/cycles", apiError(404, "not_found", "Team ZZ not found")));
    await screen.findByRole("heading", { name: /not found|Not found/i });
  });
});

describe("one cycle", () => {
  const detail = (over = {}) =>
    cycleDetail({
      number: 3,
      name: "Spring",
      goal: "Ship billing",
      total: 2,
      done: 1,
      open: 1,
      issues: [
        { ref: "AA-1", title: "Take the money", priority: "high", status: "Done", done: true, assigneeId: null },
        { ref: "AA-2", title: "Send the receipt", priority: "medium", status: "Todo", done: false, assigneeId: null },
      ],
      landed: [
        { ref: "AA-1", title: "Take the money", issueId: "t1", doneAt: days(-1), inCycle: true },
        { ref: "AA-9", title: "A fix from another corner", issueId: "t9", doneAt: days(-1), inCycle: false },
      ],
      ...over,
    });
  const page = (d = detail(), setup: Parameters<typeof renderApp>[1] = () => {}) => renderApp("/t/AA/cycles/3", (s) => (s.on("GET /api/app/teams/AA/cycles/3", { cycle: d }), setup(s)));

  test("its issues with done and open marks, and what landed with the ones that were not in the cycle called out", async () => {
    page();
    await screen.findByRole("heading", { level: 2, name: "Cycle 3: Spring" });
    const issues = screen.getByRole("region", { name: "Issues in this cycle" });
    expect(within(issues).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["AA-1 Take the moneyDone", "AA-2 Send the receiptTodo"]);
    expect(within(issues).getByRole("img", { name: "done" })).toBeTruthy();
    expect(within(issues).getByRole("img", { name: "open" })).toBeTruthy();
    const landed = screen.getByRole("region", { name: "What landed" });
    expect(within(landed).getAllByRole("listitem")).toHaveLength(2);
    expect(within(landed).getAllByText("outside the cycle")).toHaveLength(1);
    expect(within(landed).getByText("A fix from another corner").closest("li")!.textContent).toContain("outside the cycle");
    expect(within(issues).getByRole("link", { name: /AA-2/ }).getAttribute("href")).toBe("/w/ae/t/AA?t=AA-2");
  });

  test("an upcoming cycle says it has not started; a cycle with nothing done says so", async () => {
    const { unmount } = page(detail({ state: "upcoming", landed: [], issues: [], total: 0, done: 0, open: 0 }));
    await screen.findByText("The cycle has not started.");
    expect(screen.getByText(/No issues yet/)).toBeTruthy();
    unmount();
    page(detail({ landed: [] }));
    await screen.findByText("Nothing has reached Done in this window.");
  });

  test("editing saves the name, goal and dates; a cycle that has ended can change only the name and the goal", async () => {
    const { server, unmount } = page(detail(), (s) => s.on("PATCH /api/app/teams/AA/cycles/3", { cycle: cycleSummary({ number: 3 }) }));
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Edit" }));
    await user.clear(screen.getByRole("textbox", { name: "Goal" }));
    await user.type(screen.getByRole("textbox", { name: "Goal" }), "A better goal");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(server.sent("PATCH /api/app/teams/AA/cycles/3")).toHaveLength(1));
    const sent = server.sent("PATCH /api/app/teams/AA/cycles/3")[0].body as Record<string, string>;
    expect([sent.name, sent.goal]).toEqual(["Spring", "A better goal"]);
    expect(sent.startsAt && sent.endsAt).toBeTruthy();
    unmount();

    const past = page(detail({ state: "past", startsAt: days(-16), endsAt: days(-2) }), (s) => s.on("PATCH /api/app/teams/AA/cycles/3", { cycle: cycleSummary({ number: 3 }) }));
    await user.click(await screen.findByRole("button", { name: "Edit" }));
    expect(screen.queryByLabelText(/Lasts/)).toBeNull();
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(past.server.sent("PATCH /api/app/teams/AA/cycles/3")).toHaveLength(1));
    expect(Object.keys(past.server.sent("PATCH /api/app/teams/AA/cycles/3")[0].body as object).sort()).toEqual(["goal", "name"]);
  });

  test("deleting asks first, says its issues stay on the board, deletes and goes back to the list", async () => {
    const { server, router } = page(detail(), (s) => {
      s.on("DELETE /api/app/teams/AA/cycles/3", { ok: true, number: 3, released: 2 });
      s.on("GET /api/app/teams/AA/cycles", LIST());
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Delete" }));
    const confirm = await screen.findByRole("alertdialog");
    expect(confirm.textContent).toContain("Its 2 issues stay on the board, in no cycle.");
    await user.click(within(confirm).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(server.sent("DELETE /api/app/teams/AA/cycles/3")).toHaveLength(1));
    await waitFor(() => expect(router.state.location.pathname).toBe("/w/ae/t/AA/cycles"));
  });

  test("an address that is not a cycle number, or a cycle the team does not have, is not found", async () => {
    renderApp("/t/AA/cycles/abc");
    await screen.findByRole("heading", { name: /not found/i });
  });
});
