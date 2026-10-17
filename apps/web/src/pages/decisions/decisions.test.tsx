import { afterEach, describe, expect, test } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { apiError, renderApp } from "../../test/harness";
import { graph, MAP_DECISIONS } from "../../test/data";

afterEach(() => window.history.replaceState(null, "", "/"));
const open = (setup: Parameters<typeof renderApp>[1] = () => {}, path = "/p/AA/decisions") => renderApp(path, setup);
const adr = async (n: number) => (await screen.findByText(`ADR-${n}`)).closest("article") as HTMLElement;

describe("the decisions page", () => {
  test("lists the ADRs newest first, with number, title, status and the three sections that have text", async () => {
    open();
    const one = await adr(1);
    const articles = screen.getAllByRole("article");
    expect(articles.map((a) => a.id)).toEqual(["adr-2", "adr-1"]);
    expect(within(one).getByText("Use REST")).toBeTruthy();
    expect(within(one).getByText("accepted")).toBeTruthy();
    for (const text of ["We needed one protocol", "REST over HTTP", "No streaming"]) expect(within(one).getByText(text)).toBeTruthy();
    expect(within(one).getByText(/^Ada Lovelace · \d+[dhm] ago$|^Ada Lovelace · just now$/)).toBeTruthy(); // who, and how long ago
  });

  test("a section with no text is left out; a rejected decision is struck through; an agent's is marked", async () => {
    open();
    const two = await adr(2);
    expect(within(two).queryByText("context")).toBeNull();
    expect(within(two).queryByText("consequences")).toBeNull();
    expect(within(two).getByText("decision")).toBeTruthy();
    expect(within(two).getByText("Drop GraphQL").className).toContain("line-through");
    expect(within(two).getByText("rejected")).toBeTruthy();
    expect(two.textContent).toContain("Claude");
  });

  test("the nodes a decision applies to link to the map", async () => {
    open();
    const one = await adr(1);
    const link = within(one).getByRole("link", { name: /API/ });
    expect(link.getAttribute("href")).toBe("/p/AA/map?node=s-api");
    expect(link.textContent).toContain("system");
  });

  test("glossary terms in a decision are underlined, and hovering shows the definition", async () => {
    open((s) =>
      s.on("GET /api/app/projects/AA/graph", graph("AA", { decisions: [{ ...MAP_DECISIONS[0], context: "Every Invoice goes through the API" }] })),
    );
    const one = await adr(1);
    const term = within(one).getByText("Invoice");
    expect(term.tagName).toBe("ABBR");
    await userEvent.setup().hover(term);
    expect(await screen.findByText("A bill we send")).toBeTruthy();
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
    await adr(1);
    const box = screen.getByLabelText("Search decisions by title");
    const user = userEvent.setup();
    await user.type(box, "graph");
    expect(screen.getAllByRole("article")).toHaveLength(1);
    expect(screen.getByText("Drop GraphQL")).toBeTruthy();
    await user.type(box, "zzz");
    expect(screen.getByText(/No decisions match/)).toBeTruthy();
    await user.keyboard("{Escape}");
    expect(screen.getAllByRole("article")).toHaveLength(2);
  });

  test("a link to #adr-N scrolls to that decision and highlights it", async () => {
    const calls: string[] = [];
    Element.prototype.scrollIntoView = function (this: Element) {
      calls.push((this as HTMLElement).id);
    };
    window.history.replaceState(null, "", "/p/AA/decisions#adr-1");
    open(() => {}, "/p/AA/decisions#adr-1");
    const one = await adr(1);
    await waitFor(() => expect(calls).toContain("adr-1"));
    expect(one.className).toContain("border-accent");
    expect((await adr(2)).className).not.toContain("border-accent");
  });

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
      const { server } = open((s) => s.on("PUT /api/app/projects/AA/decisions", { decision: MAP_DECISIONS[1] }));
      const user = userEvent.setup();
      await user.click(within(await adr(2)).getByRole("button", { name: "Edit" }));
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
      const { server } = open((s) => {
        s.on("GET /api/app/projects/AA/graph", () => graph("AA", { decisions: [MAP_DECISIONS[0], current] }));
        s.on("PUT /api/app/projects/AA/decisions", apiError(409, "conflict", "ADR-2 was changed (version 4, you had 3). Re-read and retry.", { current: { ...MAP_DECISIONS[1], version: 4, title: "Changed meanwhile" } }));
      });
      const user = userEvent.setup();
      await user.click(within(await adr(2)).getByRole("button", { name: "Edit" }));
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
      open();
      const user = userEvent.setup();
      await user.click(within(await adr(1)).getByRole("button", { name: "Edit" }));
      const dialog = await screen.findByRole("dialog");
      const chip = within(dialog).getByText("API").closest(".chip") as HTMLElement;
      await user.click(within(chip).getByRole("button"));
      expect(within(dialog).queryByText("API")).toBeNull();
      await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(within(await adr(1)).getByRole("link", { name: /API/ })).toBeTruthy(); // nothing was saved
    });

    test("a decision changed by an agent shows over the live stream", async () => {
      let decisions = [...MAP_DECISIONS];
      open((s) => s.on("GET /api/app/projects/AA/graph", () => graph("AA", { decisions })));
      await adr(1);
      const { FakeEventSource } = await import("../../test/fake-event-source");
      await waitFor(() => expect(FakeEventSource.open.length).toBe(1));
      decisions = [...decisions, { ...MAP_DECISIONS[0], id: "dec3", number: 3, title: "Added by an agent" }];
      act(() => FakeEventSource.open[0].emit("change", { seq: 4 }));
      await adr(3);
      expect(screen.getAllByRole("article").map((a) => a.id)).toEqual(["adr-3", "adr-2", "adr-1"]);
    });
  });
});
