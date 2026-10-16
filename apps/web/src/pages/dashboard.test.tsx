import { describe, expect, test, vi } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { apiError, renderApp, renderIn } from "../test/harness";
import { DashboardRefresh } from "./dashboard/refresh";
import { serveWidgets, widgets } from "../test/data";
import { FakeEventSource } from "../test/fake-event-source";



/** A widget's frame once it has loaded. (Its skeleton is a different element, so a frame taken while loading goes stale.) */
const widget = (title: string) =>
  waitFor(() => {
    const frame = screen.getByRole("heading", { name: title }).closest("section") as HTMLElement;
    expect(frame.getAttribute("aria-busy")).toBeNull();
    return frame;
  });
/** A widget's frame right now, loaded or not. */
const frameNow = async (title: string) => (await screen.findByRole("heading", { name: title })).closest("section") as HTMLElement;

describe("the dashboard", () => {
  test("greets the person by first name, with their team, and offers a new project", async () => {
    renderApp("/");
    expect(await screen.findByRole("heading", { level: 1, name: /^Good (morning|afternoon|evening), Ada$/ })).toBeTruthy();
    expect(screen.getByText("How Analytical Engines's projects are moving, and what the agents are up to.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "+ New project" }).getAttribute("href")).toBe("/projects/new");
  });

  test("every widget is drawn from its own endpoint", async () => {
    const { server } = renderApp("/");
    for (const title of ["Project progress", "Needs attention", "Throughput", "Who's doing the work", "Agents", "Sync health", "Recent activity"]) await widget(title);
    await screen.findByText("Open tickets");
    for (const name of ["kpis", "progress", "attention", "throughput", "activity-split", "agents", "sync", "recent"]) {
      expect(server.sent(`GET /api/app/dashboard/${name}`).length, name).toBe(1);
    }
  });

  test("the numbers: counts, the change against the prior week, and the agent share", async () => {
    renderApp("/");
    const tile = async (label: string) => (await screen.findByText(label)).closest(".card") as HTMLElement;
    expect(within(await tile("Open tickets")).getByText("14")).toBeTruthy();
    expect(within(await tile("Open tickets")).getByText("across 2 projects")).toBeTruthy();
    expect(within(await tile("In progress")).getByText("2 waiting for review")).toBeTruthy();
    const completed = await tile("Completed, last 7 days");
    expect(within(completed).getByText("5")).toBeTruthy();
    expect(completed.textContent).toContain("▲ +2");
    expect(completed.textContent).toContain("vs prior 7 days");
    expect(within(await tile("Agent share of changes")).getByText("40%")).toBeTruthy();
  });

  test("with no agent activity the share is a dash, not 0%", async () => {
    renderApp("/", (s) => serveWidgets(s, { ...widgets(), kpis: { ...widgets().kpis, agentShare7d: null, events7d: 0 } }));
    expect(within((await screen.findByText("Agent share of changes")).closest(".card") as HTMLElement).getByText("—")).toBeTruthy();
  });

  test("project progress: the percentage, the stages, and links into the project", async () => {
    renderApp("/");
    const card = await widget("Project progress");
    expect(await within(card).findByText("40%")).toBeTruthy();
    expect(within(card).getByText(/done · 4\/10/)).toBeTruthy();
    expect(within(card).getByRole("link", { name: /Alpha/ }).getAttribute("href")).toBe("/p/AA");
    expect(within(card).getByText("▲ 2 high/urgent")).toBeTruthy();
    expect(within(card).getByText("🤖 1 AI-ready")).toBeTruthy();
    expect(within(card).getByRole("link", { name: "⚠ 1 stale" }).getAttribute("href")).toBe("/p/AA/map");
    expect(within(card).getByRole("link", { name: "⚠ 1 stale doc" }).getAttribute("href")).toBe("/p/AA/docs");
    for (const stage of ["Backlog", "Todo", "In Progress", "Review", "Done"]) expect(within(card).getAllByText(stage).length).toBeGreaterThan(0);
  });

  test("with no projects it points to creating one", async () => {
    renderApp("/", (s) => serveWidgets(s, { ...widgets(), progress: [] }));
    const card = await widget("Project progress");
    expect(await within(card).findByText(/No projects yet/)).toBeTruthy();
    expect(within(card).getByRole("link", { name: "Create one" }).getAttribute("href")).toBe("/projects/new");
  });

  test("needs attention: review, urgent, stale explanations and stale docs each link to the thing", async () => {
    renderApp("/");
    const card = await widget("Needs attention");
    expect((await within(card).findByRole("link", { name: /AA-7.*Add the login page/ })).getAttribute("href")).toBe("/p/AA?t=AA-7");
    expect(within(card).getByRole("link", { name: /AA-9.*Fix the crash.*In Progress/ }).getAttribute("href")).toBe("/p/AA?t=AA-9");
    expect(within(card).getByRole("link", { name: /Service layer/ }).getAttribute("href")).toBe("/p/AA/map?node=n1");
    expect(within(card).getByRole("link", { name: /Runbook/ }).getAttribute("href")).toBe("/p/AA/docs?doc=d1");
    expect(within(card).getByTitle("Agent work")).toBeTruthy();
  });

  test("when nothing needs attention it says so", async () => {
    renderApp("/", (s) => serveWidgets(s, { ...widgets(), attention: { review: [], urgent: [], stale: [], staleDocs: [] } }));
    expect(await within(await widget("Needs attention")).findByText("Nothing waiting on you. 🎉")).toBeTruthy();
  });

  test("agents: who has changes queued, and who is in sync", async () => {
    renderApp("/");
    const card = await widget("Agents");
    const busy = ((await within(card).findByText("🤖 Claude — Ada's laptop")).closest("li")) as HTMLElement;
    expect(within(busy).getByText("3 queued")).toBeTruthy();
    expect(within(busy).getByRole("button", { name: "mark all seen" })).toBeTruthy();
    const quiet = (within(card).getByText("🤖 CI bot").closest("li")) as HTMLElement;
    expect(within(quiet).getByText("in sync")).toBeTruthy();
    expect(within(quiet).getByText("never connected")).toBeTruthy();
    expect(within(card).getByRole("link", { name: "Manage →" }).getAttribute("href")).toBe("/agents");
  });

  test("mark all seen resets that agent's queue and reads the dashboard again", async () => {
    const { server } = renderApp("/", (s) => s.on("POST /api/app/agents/mark-all-seen", { ok: true }));
    const busy = (await within(await widget("Agents")).findByText("🤖 Claude — Ada's laptop")).closest("li") as HTMLElement;
    await userEvent.setup().click(within(busy).getByRole("button", { name: "mark all seen" }));
    await waitFor(() => expect(server.sent("POST /api/app/agents/mark-all-seen")).toHaveLength(1));
    expect(server.sent("POST /api/app/agents/mark-all-seen")[0].body).toEqual({ keyId: "k1" });
    await waitFor(() => expect(server.sent("GET /api/app/dashboard/agents").length).toBe(2));
  });

  test("a session can be removed after confirming, and not if the person cancels", async () => {
    const sessions = [{ id: "11111111-aaaa-bbbb-cccc-dddddddddddd", pending: 0, lastSeenAt: new Date().toISOString(), bucket: "h6" as const, reading: true, branch: "main", ticket: null, projectKey: "AA" }];
    const data = widgets();
    data.agents = [{ ...data.agents[0], sessions }];
    const { server } = renderApp("/", (s) => {
      serveWidgets(s, data);
      s.on("DELETE /api/app/projects/AA/sessions/11111111-aaaa-bbbb-cccc-dddddddddddd", { ok: true });
    });
    const user = userEvent.setup();
    const button = await screen.findByRole("button", { name: "Remove session 11111111" });
    vi.spyOn(window, "confirm").mockReturnValueOnce(false);
    await user.click(button);
    expect(server.sent("DELETE /api/app/projects/AA/sessions/11111111-aaaa-bbbb-cccc-dddddddddddd")).toHaveLength(0);
    vi.spyOn(window, "confirm").mockReturnValueOnce(true);
    await user.click(button);
    await waitFor(() => expect(server.sent("DELETE /api/app/projects/AA/sessions/11111111-aaaa-bbbb-cccc-dddddddddddd")).toHaveLength(1));
    await waitFor(() => expect(server.sent("GET /api/app/dashboard/agents").length).toBeGreaterThan(1));
  });

  test("sync health: quiet agents link to their ticket; with nothing drifting it says so", async () => {
    renderApp("/");
    const card = await widget("Sync health");
    expect((await within(card).findByRole("link", { name: /AA-4/ })).getAttribute("href")).toBe("/p/AA?t=AA-4");
    expect(within(card).getByText("Agent went quiet")).toBeTruthy();
    renderApp("/", (s) => serveWidgets(s, { ...widgets(), sync: { untracked: [], quiet: [], drafts: [] } }));
    expect((await screen.findAllByText("Board and map match the work in flight.")).length).toBeGreaterThan(0);
  });

  test("recent activity: two lines per event, agents marked, and a long list is behind +N more", async () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ seq: i, projectKey: "AA", actorKind: "human" as const, actorName: "Ada Lovelace", summary: `event ${i}`, createdAt: new Date().toISOString() }));
    renderApp("/", (s) => serveWidgets(s, { ...widgets(), recent: many }));
    const card = await widget("Recent activity");
    expect(await within(card).findByText("event 0")).toBeTruthy();
    expect(within(card).queryByText("event 3")).toBeNull();
    expect(within(card).getByRole("button", { name: "+5 more" })).toBeTruthy();
    expect(within(card).getByText("event 0").closest("a")?.getAttribute("href")).toBe("/p/AA/activity");
  });

  test("agent events are marked with the robot", async () => {
    renderApp("/");
    expect(await within(await widget("Recent activity")).findByText("🤖 Claude — Ada's laptop · just now")).toBeTruthy();
  });
});

describe("widgets load and fail on their own", () => {
  test("each shows a busy skeleton in its own frame until its data arrives", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    renderApp("/", (s) => {
      serveWidgets(s);
      s.on("GET /api/app/dashboard/throughput", async () => {
        await gate;
        return widgets().throughput;
      });
    });
    expect((await frameNow("Throughput")).getAttribute("aria-busy")).toBe("true");
    expect(await within(await widget("Project progress")).findByText("40%")).toBeTruthy(); // the others did not wait
    expect((await frameNow("Throughput")).getAttribute("aria-busy")).toBe("true");
    release();
    expect(await within(await widget("Throughput")).findByText(/Created/)).toBeTruthy();
  });

  test("one widget failing leaves the others alone and offers Try again, which works", async () => {
    let healthy = false;
    const { server } = renderApp("/", (s) =>
      s.on("GET /api/app/dashboard/sync", () => (healthy ? widgets().sync : apiError(500, "internal", "Internal error"))),
    );
    expect(await within(await widget("Project progress")).findByText("40%")).toBeTruthy();
    const alert = await waitFor(() => within(screen.getByRole("heading", { name: "Sync health" }).closest("section") as HTMLElement).getByRole("alert"), { timeout: 8000 });
    expect(alert.textContent).toContain("Internal error");
    expect(screen.queryByTestId("route-error")).toBeNull(); // not a page error
    healthy = true;
    await userEvent.setup().click(within(alert).getByRole("button", { name: "Try again" }));
    expect(await within(await widget("Sync health")).findByText("Agent went quiet")).toBeTruthy();
    expect(server.sent("GET /api/app/dashboard/sync").length).toBeGreaterThan(1);
  }, 20_000); // a failing read is retried a couple of times, with a pause, before the widget gives up
});

describe("staying fresh", () => {
  test("the team's event stream refreshes every widget, and the person's own identity is not re-read", async () => {
    const { server } = renderApp("/");
    await screen.findByText("Open tickets");
    await waitFor(() => expect(FakeEventSource.open.map((s) => s.url)).toEqual(["/api/stream"]));
    const meBefore = server.sent("GET /api/app/me").length;
    act(() => FakeEventSource.open[0].emit("change", { seq: 7 }));
    await waitFor(() => expect(server.sent("GET /api/app/dashboard/kpis").length).toBe(2));
    expect(server.sent("GET /api/app/dashboard/recent").length).toBe(2);
    expect(server.sent("GET /api/app/me").length).toBe(meBefore);
  });

  test("on a timer while the tab is visible, as a safety net; not while it is hidden; and again when the tab comes back", async () => {
    const { services } = renderIn(<DashboardRefresh intervalMs={40} />);
    const refreshed = vi.spyOn(services.queryClient, "invalidateQueries");
    const hidden = (value: boolean) => Object.defineProperty(document, "hidden", { configurable: true, value });
    try {
      hidden(true);
      await new Promise((r) => setTimeout(r, 150));
      expect(refreshed).not.toHaveBeenCalled();
      hidden(false);
      await waitFor(() => expect(refreshed).toHaveBeenCalledWith({ queryKey: ["dashboard"] }));
      const n = refreshed.mock.calls.length;
      act(() => void document.dispatchEvent(new Event("visibilitychange")));
      expect(refreshed.mock.calls.length).toBeGreaterThan(n);
    } finally {
      hidden(false);
    }
  });

  test("the timer stops when the dashboard is closed", async () => {
    const { services, unmount } = renderIn(<DashboardRefresh intervalMs={30} />);
    const refreshed = vi.spyOn(services.queryClient, "invalidateQueries");
    await waitFor(() => expect(refreshed).toHaveBeenCalled());
    unmount();
    const n = refreshed.mock.calls.length;
    await new Promise((r) => setTimeout(r, 120));
    expect(refreshed.mock.calls.length).toBe(n);
  });
});
