import { afterEach, describe, expect, test } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { apiError, renderApp } from "../../test/harness";
import { graph, MAP_DECISIONS } from "../../test/data";

afterEach(() => window.history.replaceState(null, "", "/"));
const open = (setup: Parameters<typeof renderApp>[1] = () => {}, path = "/p/AA/decisions") => renderApp(path, setup);
/** One decision's own page. */
const detail = async (n: number, setup: Parameters<typeof renderApp>[1] = () => {}) => {
  const app = open(setup, `/p/AA/decisions/${n}`);
  await screen.findByText(`ADR-${n}`);
  return app;
};
const cards = () => within(screen.getByRole("list")).getAllByRole("link");

describe("the decisions home", () => {
  test("is a grid of cards, newest first, each a link to its decision showing the title and its labels", async () => {
    open();
    await screen.findByRole("heading", { name: "Decisions" });
    const links = cards();
    expect(links.map((a) => a.getAttribute("href"))).toEqual(["/p/AA/decisions/2", "/p/AA/decisions/1"]);
    expect(screen.getByRole("list").className).toContain("lg:grid-cols-3");
    // The labels: the status, then the map nodes it applies to (as text: the card itself is the link).
    const one = screen.getByRole("link", { name: /Use REST/ });
    expect(within(one).getByText("accepted")).toBeTruthy();
    expect(within(one).getByText("API")).toBeTruthy();
    expect(within(screen.getByRole("link", { name: /Drop GraphQL/ })).getByText("rejected")).toBeTruthy();
    // Not the body, the number or who wrote it.
    expect(screen.queryByText("ADR-1")).toBeNull();
    expect(screen.queryByText("We needed one protocol")).toBeNull();
  });

  test("a card shows at most three nodes and counts the rest", async () => {
    const many = { ...MAP_DECISIONS[0], nodeIds: ["s-api", "s-api", "s-api", "s-api", "s-api"] };
    open((s) => s.on("GET /api/app/projects/AA/graph", graph("AA", { decisions: [many] })));
    await screen.findByRole("heading", { name: "Decisions" });
    expect(within(cards()[0]).getAllByText("API")).toHaveLength(3);
    expect(within(cards()[0]).getByText("+2")).toBeTruthy();
  });

  test("a rejected or superseded decision's title is struck through", async () => {
    open();
    await screen.findByRole("heading", { name: "Decisions" });
    expect(screen.getByText("Drop GraphQL").className).toContain("line-through");
    expect(screen.getByText("Use REST").className).not.toContain("line-through");
  });

  test("with no decisions it explains how they get made; the search appears only when there are some", async () => {
    const { unmount } = open((s) => s.on("GET /api/app/projects/AA/graph", graph("AA", { decisions: [] })));
    await screen.findByText(/No decisions yet\./);
    expect(screen.queryByLabelText("Search decisions by title")).toBeNull();
    unmount();
    open();
    expect(await screen.findByLabelText("Search decisions by title")).toBeTruthy();
  });

  test("the search narrows by title, Escape clears it, and it says when nothing matches", async () => {
    open();
    await screen.findByRole("heading", { name: "Decisions" });
    const box = screen.getByLabelText("Search decisions by title");
    const user = userEvent.setup();
    await user.type(box, "graph");
    expect(cards()).toHaveLength(1);
    expect(screen.getByText("Drop GraphQL")).toBeTruthy();
    await user.type(box, "zzz");
    expect(screen.getByText(/No decisions match/)).toBeTruthy();
    await user.keyboard("{Escape}");
    expect(cards()).toHaveLength(2);
  });

  test("clicking a card opens that decision at its own address", async () => {
    const { at } = open();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("link", { name: /^Use REST/ }));
    await waitFor(() => expect(at()).toBe("/p/AA/decisions/1"));
    expect(await screen.findByText("ADR-1")).toBeTruthy();
  });

  test("an old link to #adr-N opens that decision", async () => {
    const { at } = open(() => {}, "/p/AA/decisions#adr-1");
    await waitFor(() => expect(at()).toBe("/p/AA/decisions/1"));
    expect(await screen.findByText("ADR-1")).toBeTruthy();
  });
});

describe("one decision", () => {
  test("shows the title, number, status, who and when, and the three sections that have text", async () => {
    await detail(1);
    expect(screen.getByRole("heading", { name: "Use REST" })).toBeTruthy();
    expect(screen.getByText("accepted")).toBeTruthy();
    for (const text of ["We needed one protocol", "REST over HTTP", "No streaming"]) expect(screen.getByText(text)).toBeTruthy();
    expect(screen.getByText(/^Ada Lovelace · \d+[dhm] ago$|^Ada Lovelace · just now$/)).toBeTruthy();
    expect(within(screen.getByRole("navigation", { name: "Decision navigation" })).getByRole("link", { name: /Decisions/ }).getAttribute("href")).toBe("/p/AA/decisions");
  });

  test("a section with no text is left out; a rejected decision is struck through; an agent's is marked", async () => {
    await detail(2);
    expect(screen.queryByText("context")).toBeNull();
    expect(screen.queryByText("consequences")).toBeNull();
    expect(screen.getByText("decision")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Drop GraphQL" }).className).toContain("line-through");
    expect(screen.getByText("rejected")).toBeTruthy();
    expect(document.body.textContent).toContain("Claude");
  });

  test("the nodes a decision applies to link to the map", async () => {
    await detail(1);
    const link = within(screen.getByRole("article")).getByRole("link", { name: /API/ });
    expect(link.getAttribute("href")).toBe("/p/AA/map?node=s-api");
    expect(link.textContent).toContain("system");
  });

  test("glossary terms in a decision are underlined, and hovering shows the definition", async () => {
    await detail(1, (s) =>
      s.on("GET /api/app/projects/AA/graph", graph("AA", { decisions: [{ ...MAP_DECISIONS[0], context: "Every Invoice goes through the API" }] })),
    );
    const term = screen.getByText("Invoice");
    expect(term.tagName).toBe("ABBR");
    await userEvent.setup().hover(term);
    expect(await screen.findByText("A bill we send")).toBeTruthy();
  });

  test("a number that is not a decision of this project says so", async () => {
    open(() => {}, "/p/AA/decisions/99");
    expect(await screen.findByText("No decision ADR-99 in this project.")).toBeTruthy();
  });
});

describe("the decisions page", () => {
  describe("recording and editing", () => {
    test("+ Record decision needs a title, and saves a new ADR with the chosen nodes", async () => {
      const { server } = open((s) => s.on("PUT /api/app/projects/AA/decisions", { decision: { ...MAP_DECISIONS[0], number: 3 } }));
      const user = userEvent.setup();
      await user.click(await screen.findByRole("button", { name: "+ Record decision" }));
      const dialog = await screen.findByRole("dialog");
      expect(within(dialog).getByText("Record a decision")).toBeTruthy();
      const save = within(dialog).getByRole("button", { name: "Save" }) as HTMLButtonElement;
      expect(save.disabled).toBe(true);
      await user.type(within(dialog).getByPlaceholderText(/Use 303 redirects/), "Use queues");
      const [context, decision] = within(dialog).getAllByRole("textbox").slice(1, 3);
      await user.type(context, "Because of load");
      await user.type(decision, "Add a queue");
      await user.click(within(dialog).getByText("+ map node").closest("button") as HTMLElement);
      await user.click(await screen.findByRole("option", { name: "system: API" }));
      expect(save.disabled).toBe(false);
      await user.click(save);
      await waitFor(() => expect(server.sent("PUT /api/app/projects/AA/decisions")).toHaveLength(1));
      expect(server.sent("PUT /api/app/projects/AA/decisions")[0].body).toEqual({ title: "Use queues", status: "accepted", context: "Because of load", decision: "Add a queue", consequences: "", nodes: ["s-api"] });
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    });

    test("Edit opens the ADR with its text, and saves against the version it was read at", async () => {
      const user = userEvent.setup();
      const { server } = await detail(2, (s) => s.on("PUT /api/app/projects/AA/decisions", { decision: MAP_DECISIONS[1] }));
      await user.click(screen.getByRole("button", { name: "Edit" }));
      const dialog = await screen.findByRole("dialog");
      expect(within(dialog).getByText("Edit ADR-2")).toBeTruthy();
      expect((within(dialog).getByPlaceholderText(/Use 303 redirects/) as HTMLInputElement).value).toBe("Drop GraphQL");
      await user.type(within(dialog).getByPlaceholderText(/Use 303 redirects/), " for now");
      await user.click(within(dialog).getByRole("button", { name: "Save" }));
      await waitFor(() => expect(server.sent("PUT /api/app/projects/AA/decisions")).toHaveLength(1));
      const body = server.sent("PUT /api/app/projects/AA/decisions")[0].body as Record<string, unknown>;
      expect([body.number, body.version, body.title]).toEqual([2, 3, "Drop GraphQL for now"]);
    });

    test("a stale edit is refused with the server's message, the dialog stays open with the draft, and the page shows the ADR as it is now", async () => {
      let current = MAP_DECISIONS[1];
      const user = userEvent.setup();
      const { server } = await detail(2, (s) => {
        s.on("GET /api/app/projects/AA/graph", () => graph("AA", { decisions: [MAP_DECISIONS[0], current] }));
        s.on("PUT /api/app/projects/AA/decisions", apiError(409, "conflict", "ADR-2 was changed (version 4, you had 3). Re-read and retry.", { current: { ...MAP_DECISIONS[1], version: 4, title: "Changed meanwhile" } }));
      });
      await user.click(screen.getByRole("button", { name: "Edit" }));
      const dialog = await screen.findByRole("dialog");
      await user.type(within(dialog).getByPlaceholderText(/Use 303 redirects/), " (mine)");
      current = { ...MAP_DECISIONS[1], version: 4, title: "Changed meanwhile" };
      await user.click(within(dialog).getByRole("button", { name: "Save" }));
      expect(await within(dialog).findByText("ADR-2 was changed (version 4, you had 3). Re-read and retry.")).toBeTruthy();
      expect((within(dialog).getByPlaceholderText(/Use 303 redirects/) as HTMLInputElement).value).toBe("Drop GraphQL (mine)");
      expect(server.sent("PUT /api/app/projects/AA/decisions")).toHaveLength(1);
      await waitFor(() => expect(screen.getAllByText("Changed meanwhile").length).toBeGreaterThan(0));
    });

    test("a node can be taken off the list and another added; Cancel throws the edit away", async () => {
      const user = userEvent.setup();
      await detail(1);
      await user.click(screen.getByRole("button", { name: "Edit" }));
      const dialog = await screen.findByRole("dialog");
      const chip = within(dialog).getByText("API").closest(".chip") as HTMLElement;
      await user.click(within(chip).getByRole("button"));
      expect(within(dialog).queryByText("API")).toBeNull();
      await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(within(screen.getByRole("article")).getByRole("link", { name: /API/ })).toBeTruthy(); // nothing was saved
    });

    test("a decision changed by an agent shows over the live stream", async () => {
      let decisions = [...MAP_DECISIONS];
      open((s) => s.on("GET /api/app/projects/AA/graph", () => graph("AA", { decisions })));
      await screen.findByRole("link", { name: /^Use REST/ });
      const { FakeEventSource } = await import("../../test/fake-event-source");
      await waitFor(() => expect(FakeEventSource.open.length).toBe(1));
      decisions = [...decisions, { ...MAP_DECISIONS[0], id: "dec3", number: 3, title: "Added by an agent" }];
      act(() => FakeEventSource.open[0].emit("change", { seq: 4 }));
      await screen.findByRole("link", { name: /^Added by an agent/ });
      expect(cards().map((a) => a.getAttribute("href"))).toEqual(["/p/AA/decisions/3", "/p/AA/decisions/2", "/p/AA/decisions/1"]);
    });
  });
});
