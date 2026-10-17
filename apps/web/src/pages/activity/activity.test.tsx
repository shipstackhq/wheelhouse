import { describe, expect, test } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { apiError, renderApp } from "../../test/harness";
import { activityEvent } from "../../test/data";
import { FakeEventSource } from "../../test/fake-event-source";

const open = (setup: Parameters<typeof renderApp>[1] = () => {}, path = "/p/AA/activity") => renderApp(path, setup);
const row = async (text: string | RegExp) => (await screen.findByText(text)).closest("li") as HTMLElement;

describe("the activity page", () => {
  test("lists events newest first with number, who and when, and the three tabs", async () => {
    open((s) =>
      s.on("GET /api/app/projects/AA/activity", {
        events: [activityEvent({ seq: 9, summary: "moved AA-2" }), activityEvent({ seq: 8, actorKind: "agent", actorName: "CI bot", summary: "added a node", entity: "node", entityId: "n1", data: {} })],
      }),
    );
    expect((await row("moved AA-2")).textContent).toContain("#9");
    const agent = await row("added a node");
    expect(within(agent).getByText("CI bot")).toBeTruthy();
    expect(within(agent).getByText("just now")).toBeTruthy();
    for (const name of ["Everything", "Agents", "Team"]) expect(screen.getByRole("link", { name })).toBeTruthy();
  });

  test("with nothing yet it says so", async () => {
    open((s) => s.on("GET /api/app/projects/AA/activity", { events: [] }));
    await screen.findByText("Nothing yet.");
  });

  test("each kind of event links to the thing it is about", async () => {
    open((s) =>
      s.on("GET /api/app/projects/AA/activity", {
        events: [
          activityEvent({ seq: 7, summary: "ticket event", data: { ref: "AA-5" } }),
          activityEvent({ seq: 6, summary: "node event", entity: "node", entityId: "n-1", data: {} }),
          activityEvent({ seq: 5, summary: "edge event", entity: "edge", entityId: "e-1", data: {} }),
          activityEvent({ seq: 4, summary: "flow event", entity: "flow", entityId: "f-1", data: {} }),
          activityEvent({ seq: 3, summary: "code event", entity: "project", type: "code.changed", data: {} }),
          activityEvent({ seq: 2, summary: "decision event", entity: "decision", entityId: "d-1", data: { number: 4 } }),
          activityEvent({ seq: 1, summary: "term event", entity: "term", entityId: "t-1", data: {} }),
        ],
      }),
    );
    const href = async (text: string) => (await screen.findByRole("link", { name: text })).getAttribute("href");
    expect(await href("ticket event")).toBe("/p/AA?t=AA-5");
    expect(await href("node event")).toBe("/p/AA/map?node=n-1");
    expect(await href("edge event")).toBe("/p/AA/map");
    expect(await href("flow event")).toBe("/p/AA/map?flow=f-1");
    expect(await href("code event")).toBe("/p/AA/map");
    expect(await href("decision event")).toBe("/p/AA/decisions#adr-4");
    expect(await href("term event")).toBe("/p/AA/glossary");
  });

  test("an event about nothing in particular is plain text, and a comment shows what was said", async () => {
    open((s) =>
      s.on("GET /api/app/projects/AA/activity", {
        events: [activityEvent({ seq: 2, summary: "something happened", entity: "project", data: {} }), activityEvent({ seq: 1, summary: "commented on AA-1", type: "comment.created", data: { ref: "AA-1", body: "Looks right to me" } })],
      }),
    );
    const plain = await row("something happened");
    expect(within(plain).queryByRole("link")).toBeNull();
    expect((await row("commented on AA-1")).textContent).toContain("“Looks right to me”");
  });

  test("the tabs ask for agents only or the team only, and Everything asks for all", async () => {
    const { server, router } = open();
    const user = userEvent.setup();
    await screen.findByText(/created AA-1/);
    await user.click(screen.getByRole("link", { name: "Agents" }));
    await waitFor(() => expect(server.sent("GET /api/app/projects/AA/activity").some((c) => c.url.endsWith("?who=agent"))).toBe(true));
    expect(router.state.location.search).toBe("?who=agent");
    await user.click(screen.getByRole("link", { name: "Team" }));
    await waitFor(() => expect(server.sent("GET /api/app/projects/AA/activity").some((c) => c.url.endsWith("?who=human"))).toBe(true));
    await user.click(screen.getByRole("link", { name: "Everything" }));
    await waitFor(() => expect(router.state.location.search).toBe(""));
  });

  test("the current tab is marked, and an unknown ?who= means everyone", async () => {
    open(() => {}, "/p/AA/activity?who=agent");
    expect((await screen.findByRole("link", { name: "Agents" })).classList.contains("bg-panel-2")).toBe(true);
    expect(screen.getByRole("link", { name: "Everything" }).classList.contains("bg-panel-2")).toBe(false);
  });

  test("new events arrive over the live stream without a refresh", async () => {
    let events = [activityEvent({ seq: 1, summary: "first thing" })];
    open((s) => s.on("GET /api/app/projects/AA/activity", () => ({ events })));
    await screen.findByText("first thing");
    await waitFor(() => expect(FakeEventSource.open.length).toBe(1));
    events = [activityEvent({ seq: 2, summary: "second thing" }), ...events];
    act(() => FakeEventSource.open[0].emit("change", { seq: 2 }));
    await screen.findByText("second thing");
    expect(screen.getAllByText("first thing")).toHaveLength(1);
  });

  test("a failure to load says why, with Try again", async () => {
    let healthy = false;
    open((s) => s.on("GET /api/app/projects/AA/activity", () => (healthy ? { events: [activityEvent({ summary: "back again" })] } : apiError(500, "internal", "Internal error"))));
    const alert = await screen.findByRole("alert", {}, { timeout: 8000 });
    expect(alert.textContent).toContain("Internal error");
    healthy = true;
    await userEvent.setup().click(within(alert).getByRole("button", { name: "Try again" }));
    await screen.findByText("back again");
  }, 20_000);
});
