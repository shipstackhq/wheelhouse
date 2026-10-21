import { describe, expect, test } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { apiError, renderApp } from "../test/harness";
import { bot } from "../test/data";

const queue = (bots: ReturnType<typeof bot>[]) => (s: { on: (r: string, a: unknown) => unknown }) => s.on("GET /api/app/teams/AA/queue", { bots });
const trigger = (name: RegExp) => screen.findByRole("button", { name });

describe("the Bots menu in the team header", () => {
  test("says there are none when no agent is connected, and points to creating a key", async () => {
    renderApp("/t/AA", queue([]));
    const t = await trigger(/^Bots: none connected$/);
    expect(t.getAttribute("title")).toBe("No bots connected");
    await userEvent.setup().click(t);
    expect(await screen.findByText("No agents connected yet.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Create an API key" }).getAttribute("href")).toBe("/agents");
  });

  test("with a queue it shows the total, and in the menu who is behind", async () => {
    renderApp("/t/AA", queue([bot({ id: "k1", name: "Ada's agent", pending: 3 }), bot({ id: "k2", name: "CI bot", pending: 0 })]));
    const t = await trigger(/^Bots: 3 queued change\(s\)$/);
    expect(t.getAttribute("title")).toBe("3 queued");
    await userEvent.setup().click(t);
    expect(await screen.findByText("Bots in AA")).toBeTruthy();
    expect(screen.getByText("1 of 2 behind")).toBeTruthy();
    const list = screen.getByText("Ada's agent").closest("li") as HTMLElement;
    expect(within(list).getByText("3 queued")).toBeTruthy();
    expect((screen.getByText("CI bot").closest("li") as HTMLElement).textContent).toContain("in sync");
    expect(screen.getByRole("link", { name: "Manage agents & API keys" })).toBeTruthy();
  });

  test("when everyone is caught up it says all in sync", async () => {
    renderApp("/t/AA", queue([bot({ pending: 0 })]));
    const t = await trigger(/^Bots: all in sync$/);
    await userEvent.setup().click(t);
    expect(await screen.findByText("All caught up")).toBeTruthy();
  });

  test("'mark all seen' resets that agent's queue in this team only, and reads the queue again", async () => {
    const { server } = renderApp("/t/AA", (s) => {
      queue([bot({ id: "k1", name: "Ada's agent", pending: 2 })])(s);
      s.on("POST /api/app/agents/mark-all-seen", { ok: true });
    });
    const user = userEvent.setup();
    await user.click(await trigger(/^Bots: 2 queued/));
    const row = (await screen.findByText("Ada's agent")).closest("li") as HTMLElement;
    await user.click(within(row).getByRole("button", { name: "mark all seen" }));
    await waitFor(() => expect(server.sent("POST /api/app/agents/mark-all-seen")).toHaveLength(1));
    expect(server.sent("POST /api/app/agents/mark-all-seen")[0].body).toEqual({ keyId: "k1", teamKey: "AA" });
    await waitFor(() => expect(server.sent("GET /api/app/teams/AA/queue").length).toBeGreaterThan(1));
  });

  test("a session can be removed from the menu, for its own team", async () => {
    const session = { id: "11111111-aaaa-bbbb-cccc-dddddddddddd", pending: 0, lastSeenAt: new Date().toISOString(), bucket: "h6" as const, reading: true, branch: "main", issue: null };
    const { server } = renderApp("/t/AA", (s) => {
      queue([bot({ pending: 0, sessions: [session] })])(s);
      s.on("DELETE /api/app/teams/AA/sessions/11111111-aaaa-bbbb-cccc-dddddddddddd", { ok: true });
    });
    const user = userEvent.setup();
    await user.click(await trigger(/^Bots: all in sync$/));
    const remove = await screen.findByRole("button", { name: "Remove session 11111111" });
    window.confirm = () => true;
    await user.click(remove);
    await waitFor(() => expect(server.sent("DELETE /api/app/teams/AA/sessions/11111111-aaaa-bbbb-cccc-dddddddddddd")).toHaveLength(1));
  });

  test("it is a skeleton while the queue loads, and simply absent if the queue cannot be read (the board still works)", async () => {
    let release!: () => void;
    renderApp("/t/AA", (s) =>
      s.on("GET /api/app/teams/AA/queue", () => new Promise((r) => (release = () => r({ bots: [] })))),
    );
    await screen.findByText("Write the plan");
    expect(screen.queryByRole("button", { name: /^Bots:/ })).toBeNull();
    await waitFor(() => expect(release).toBeTypeOf("function"));
    release();
    await trigger(/^Bots: none connected$/);

    const failing = renderApp("/t/BB", (s) => s.on("GET /api/app/teams/BB/queue", apiError(500, "internal", "Internal error")));
    expect(failing).toBeTruthy();
    await waitFor(() => expect(screen.getAllByRole("link", { name: "Issues" }).length).toBeGreaterThan(0), { timeout: 8000 });
  }, 20_000);
});
