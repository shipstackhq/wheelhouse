import { afterEach, describe, expect, test } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { apiError, renderApp, type FakeServer } from "../../test/harness";
import { graph, MAP_NODES, mapNode } from "../../test/data";
import { FakeEventSource } from "../../test/fake-event-source";

afterEach(() => window.history.replaceState(null, "", "/"));

const open = (path = "/t/AA/map", setup: (s: FakeServer) => unknown = () => {}) => renderApp(path, setup);
const mapNodes = () => [...document.querySelectorAll(".react-flow__node")] as HTMLElement[];
const nodeEl = (name: string) => mapNodes().find((n) => n.textContent?.includes(name)) as HTMLElement | undefined;
const tab = (name: RegExp) => screen.findByRole("tab", { name });
const sideOf = () => document.querySelector("aside.border-l") as HTMLElement | null;
const panel = () => waitFor(() => { const a = sideOf(); expect(a).toBeTruthy(); return a as HTMLElement; });
/** Click a node on the canvas (React Flow selects on click). */
const click = async (user: ReturnType<typeof userEvent.setup>, name: string) => {
  await waitFor(() => expect(nodeEl(name)).toBeTruthy());
  fireEvent.click(nodeEl(name)!); // a real mousedown would start a d3 drag, which jsdom cannot host
};
const expand = async (user: ReturnType<typeof userEvent.setup>, container: string) => {
  await waitFor(() => expect(nodeEl(container)).toBeTruthy());
  fireEvent.click(within(nodeEl(container)!).getByTitle("Expand"));
};
const flowsSide = async () => ((await screen.findByText("Flows", { selector: "span.text-sm" })).closest("aside") as HTMLElement);
const settled = () => new Promise((r) => setTimeout(r, 250));

describe("the lenses", () => {
  test("four layers with how many nodes each, a dot where something is stale; it opens on Systems", async () => {
    open();
    const system = await tab(/Systems/);
    expect(system.getAttribute("aria-selected")).toBe("true");
    expect(within(system).getByText("4")).toBeTruthy();
    expect(within(system).getByTitle("1 stale")).toBeTruthy();
    for (const [name, n] of [[/Concepts/, "1"], [/Data/, "2"], [/Code/, "1"]] as const) expect(within(await tab(name)).getByText(n)).toBeTruthy();
  });

  test("each lens shows its own nodes, and none of the others'", async () => {
    open();
    const user = userEvent.setup();
    await waitFor(() => expect(nodeEl("Web")).toBeTruthy());
    expect(nodeEl("Billing")).toBeUndefined();
    await user.click(await tab(/Concepts/));
    await waitFor(() => expect(nodeEl("Billing")).toBeTruthy());
    expect(nodeEl("Web")).toBeUndefined();
    await user.click(await tab(/Data/));
    await waitFor(() => expect(nodeEl("users")).toBeTruthy());
    expect(nodeEl("posts")).toBeTruthy();
    await user.click(await tab(/Code/));
    await waitFor(() => expect(nodeEl("src/pay")).toBeTruthy());
  });

  test("?lens= opens another layer, and a layer with nothing yet says what belongs there", async () => {
    open("/t/AA/map?lens=data");
    expect((await tab(/Data/)).getAttribute("aria-selected")).toBe("true");
    const { unmount } = open("/t/BB/map", (s) => s.on("GET /api/app/teams/BB/graph", graph("BB", { nodes: MAP_NODES.filter((n) => n.layer === "system"), edges: [], flows: [], decisions: [], terms: [], ticketLinks: [], flux: {} })));
    unmount();
    open("/t/BB/map?lens=code", (s) => s.on("GET /api/app/teams/BB/graph", graph("BB", { nodes: MAP_NODES.filter((n) => n.layer === "system"), edges: [], flows: [], decisions: [], terms: [], ticketLinks: [], flux: {} })));
    expect(await screen.findByText("Nothing on the Code layer yet")).toBeTruthy();
  });

  test("a team with no map explains how to make one, and offers to start by hand", async () => {
    open("/t/AA/map", (s) => s.on("GET /api/app/teams/AA/graph", graph("AA", { nodes: [], edges: [], flows: [], decisions: [], terms: [], ticketLinks: [], flux: {} })));
    expect(await screen.findByText("No knowledge map yet")).toBeTruthy();
    expect(screen.getByRole("button", { name: "+ Start one by hand" })).toBeTruthy();
  });

  test("the data layer draws a table card per table, with its columns, keys and types", async () => {
    open("/t/AA/map?lens=data");
    await waitFor(() => expect(nodeEl("posts")).toBeTruthy());
    const posts = nodeEl("posts")!;
    expect(posts.textContent).toContain("author_id");
    expect(within(posts).getByText("PK")).toBeTruthy();
    expect(within(posts).getByText("FK")).toBeTruthy();
    expect(posts.textContent).toContain("uuid");
    expect(nodeEl("users")!.textContent).toContain("UQ");
  });
});

describe("containers and collapsing", () => {
  test("a container starts collapsed to its header, says how many modules it hides and how many tickets touch it", async () => {
    open();
    await waitFor(() => expect(nodeEl("API")).toBeTruthy());
    const api = nodeEl("API")!;
    expect(within(api).getByText("+2 modules")).toBeTruthy();
    expect(within(api).getByText("1")).toBeTruthy();
    expect(nodeEl("Auth")).toBeUndefined();
  });

  test("expanding shows what is inside, and the choice is remembered for next time", async () => {
    const { unmount } = open();
    const user = userEvent.setup();
    await expand(user, "API");
    await waitFor(() => expect(nodeEl("Auth")).toBeTruthy());
    expect(nodeEl("Payments")).toBeTruthy();
    expect(localStorage.getItem("wh:map-collapsed:AA:system")).toBeNull(); // nothing collapsed now
    expect(JSON.parse(localStorage.getItem("wh:map-collapsed-seen:AA:system")!)).toContain("s-api");
    unmount();
    open();
    await waitFor(() => expect(nodeEl("Auth")).toBeTruthy()); // still expanded
  });

  test("a stale node and an in-flux node show their markings on the canvas", async () => {
    open();
    const user = userEvent.setup();
    await expand(user, "API");
    await waitFor(() => expect(nodeEl("Payments")).toBeTruthy());
    const pay = nodeEl("Payments")!;
    expect(within(pay).getByText("stale").getAttribute("title")).toBe("src/pay/charge.ts changed in abc1234");
    const auth = nodeEl("Auth")!;
    const flux = within(auth).getByText("in flux");
    expect(flux.getAttribute("title")).toBe("Being changed by Claude — Ada's laptop (AA-9); not landed yet · 1 pending map update(s)");
  });
});

describe("the node panel", () => {
  test("clicking a node opens it: kind, version, summary, and the explanation sections that have text", async () => {
    open();
    const user = userEvent.setup();
    await click(user, "Web");
    const p = await panel();
    expect(within(p).getByRole("heading", { level: 2, name: "Web" })).toBeTruthy();
    expect(within(p).getByText(/^v1/)).toBeTruthy();
    expect(within(p).getByText("The app")).toBeTruthy();
    await user.click(within(p).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(sideOf()).toBeNull());
  });

  test("?node= opens the panel on that node, on its own layer", async () => {
    open("/t/AA/map?node=c-bill");
    const p = await panel();
    expect(within(p).getByRole("heading", { level: 2, name: "Billing" })).toBeTruthy();
    expect((await tab(/Concepts/)).getAttribute("aria-selected")).toBe("true");
    expect(within(p).getByText("Why we charge")).toBeTruthy();
  });

  test("it shows what a node is connected to: depends on, used by, implements, implemented by, contents, flows, decisions and tickets", async () => {
    open("/t/AA/map?node=s-api");
    const p = await panel();
    expect(within(p).getByText("Used by")).toBeTruthy();
    expect(within(p).getByRole("button", { name: /Web/ })).toBeTruthy(); // Web depends on API
    expect(within(p).getByText("Contains (2)")).toBeTruthy();
    expect(within(p).getByRole("button", { name: /Auth/ })).toBeTruthy();
    expect(within(p).getByRole("link", { name: /ADR-1\s*Use REST/ }).getAttribute("href")).toBe("/t/AA/decisions#adr-1");
    expect(within(p).getByRole("link", { name: /AA-1 Write the plan/ }).getAttribute("href")).toBe("/t/AA?t=AA-1");
    expect(within(p).getByText("apps/api/**")).toBeTruthy();
  });

  test("a node in a flow lists it, and playing it from there starts at that step", async () => {
    open("/t/AA/map?node=s-auth");
    const p = await panel();
    expect(within(p).getByText("step 2/2")).toBeTruthy();
    await userEvent.setup().click(within(p).getByRole("button", { name: /Sign in/ }));
    expect(await screen.findByText("step 2 of 2")).toBeTruthy();
  });

  test("a stale node says why, and 'still accurate' clears it", async () => {
    const { server } = open("/t/AA/map?node=s-pay", (s) => s.on("POST /api/app/teams/AA/nodes/s-pay/fresh", { node: mapNode({ id: "s-pay", name: "Payments", layer: "system" }) }));
    const p = await panel();
    expect(within(p).getByText("Possibly out of date")).toBeTruthy();
    expect(within(p).getByText("src/pay/charge.ts changed in abc1234")).toBeTruthy();
    await userEvent.setup().click(within(p).getByRole("button", { name: "Still accurate — mark fresh" }));
    await waitFor(() => expect(server.sent("POST /api/app/teams/AA/nodes/s-pay/fresh")).toHaveLength(1));
  });

  test("an in-flux node shows who is changing which files and the map update waiting for that code; Publish now and Discard resolve it", async () => {
    const { server } = open("/t/AA/map?node=s-auth", (s) => s.on("POST /api/app/teams/AA/drafts/draft-1/resolve", { ok: true }));
    const p = await panel();
    expect(within(p).getByText("In flux")).toBeTruthy();
    expect(within(p).getByText(/Claude — Ada's laptop on AA-9 is changing apps\/api\/src\/auth\.ts, apps\/api\/src\/session\.ts/)).toBeTruthy();
    expect(within(p).getByText(/drafted: purpose\. Publishes when the code lands\./)).toBeTruthy();
    expect(within(p).getByText("Checks passwords and sessions")).toBeTruthy();
    const user = userEvent.setup();
    await user.click(within(p).getByRole("button", { name: "Publish now" }));
    await user.click(within(p).getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(server.sent("POST /api/app/teams/AA/drafts/draft-1/resolve")).toHaveLength(2));
    expect(server.sent("POST /api/app/teams/AA/drafts/draft-1/resolve").map((c) => (c.body as { action: string }).action)).toEqual(["publish", "discard"]);
  });

  test("Edit changes only what was changed, and sends the version the node was read at", async () => {
    const { server } = open("/t/AA/map?node=s-web", (s) => s.on("PUT /api/app/teams/AA/nodes", { node: MAP_NODES[4] }));
    const user = userEvent.setup();
    const p = await panel();
    await user.click(within(p).getByRole("button", { name: "Edit" }));
    const summary = within(p).getByPlaceholderText("One-line summary");
    await user.clear(summary);
    await user.type(summary, "The whole app");
    await user.click(within(p).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(server.sent("PUT /api/app/teams/AA/nodes")).toHaveLength(1));
    expect(server.sent("PUT /api/app/teams/AA/nodes")[0].body).toEqual({ id: "s-web", summary: "The whole app", version: 1 });
    expect(server.sent("PUT /api/app/teams/AA/nodes")[0].headers["x-csrf-token"]).toBe("csrf-ada");
  });

  test("code anchors are edited one per line and saved as a list", async () => {
    const { server } = open("/t/AA/map?node=s-web", (s) => s.on("PUT /api/app/teams/AA/nodes", { node: MAP_NODES[4] }));
    const user = userEvent.setup();
    const p = await panel();
    await user.click(within(p).getByRole("button", { name: "Edit" }));
    await user.type(within(p).getByPlaceholderText(/src\/lib\/service\.ts/), "apps/web/**{Enter}apps/web/index.html");
    await user.click(within(p).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(server.sent("PUT /api/app/teams/AA/nodes")).toHaveLength(1));
    expect((server.sent("PUT /api/app/teams/AA/nodes")[0].body as { anchors: string[] }).anchors).toEqual(["apps/web/**", "apps/web/index.html"]);
  });

  test("a stale save is refused: the banner shows the server's message and the map shows the node as it is now", async () => {
    let current = MAP_NODES[4];
    open("/t/AA/map?node=s-web", (s) => {
      s.on("GET /api/app/teams/AA/graph", () => graph("AA", { nodes: MAP_NODES.map((n) => (n.id === "s-web" ? current : n)) }));
      s.on("PUT /api/app/teams/AA/nodes", apiError(409, "conflict", '"Web" was changed (version 2, you had 1). Re-read and retry.', { current: { ...MAP_NODES[4], version: 2, summary: "Changed by an agent" } }));
    });
    const user = userEvent.setup();
    const p = await panel();
    await user.click(within(p).getByRole("button", { name: "Edit" }));
    await user.type(within(p).getByPlaceholderText("One-line summary"), " mine");
    current = { ...MAP_NODES[4], version: 2, summary: "Changed by an agent" };
    await user.click(within(p).getByRole("button", { name: "Save" }));
    expect(await screen.findByText('"Web" was changed (version 2, you had 1). Re-read and retry.')).toBeTruthy();
    await waitFor(() => expect(within(sideOf()!).getByText("Changed by an agent")).toBeTruthy());
  });

  test("Kind, Status and Inside are saved straight away, with the version", async () => {
    const { server } = open("/t/AA/map?node=s-web", (s) => s.on("PUT /api/app/teams/AA/nodes", { node: MAP_NODES[4] }));
    const user = userEvent.setup();
    const p = await panel();
    const select = async (label: string, option: string) => {
      const field = within(p).getByText(label, { selector: "span.label" }).parentElement as HTMLElement;
      await user.click(within(field).getByRole("combobox"));
      await user.click(await screen.findByRole("option", { name: option }));
    };
    await select("Status", "building");
    await waitFor(() => expect(server.sent("PUT /api/app/teams/AA/nodes")).toHaveLength(1));
    expect(server.sent("PUT /api/app/teams/AA/nodes")[0].body).toEqual({ id: "s-web", status: "building", version: 1 });
    await select("Kind", "database");
    await waitFor(() => expect(server.sent("PUT /api/app/teams/AA/nodes")).toHaveLength(2));
    expect((server.sent("PUT /api/app/teams/AA/nodes")[1].body as { kind: string }).kind).toBe("database");
  });

  test("Delete asks first, and says how many nested nodes go with it", async () => {
    const { server } = open("/t/AA/map?node=s-api", (s) => s.on("DELETE /api/app/teams/AA/nodes/s-api", { ok: true }));
    const user = userEvent.setup();
    const p = await panel();
    await user.click(within(p).getByRole("button", { name: "Delete node" }));
    const ask = await screen.findByRole("alertdialog");
    expect(within(ask).getByText("Delete “API”?")).toBeTruthy();
    expect(within(ask).getByText("This also deletes 2 nested node(s).")).toBeTruthy();
    await user.click(within(ask).getByRole("button", { name: "Cancel" }));
    expect(server.sent("DELETE /api/app/teams/AA/nodes/s-api")).toHaveLength(0);
    await user.click(within(p).getByRole("button", { name: "Delete node" }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(server.sent("DELETE /api/app/teams/AA/nodes/s-api")).toHaveLength(1));
    await waitFor(() => expect(sideOf()).toBeNull());
  });

  test("links in an explanation: #node:... selects that node, #adr:N goes to the decision", async () => {
    const nodes = MAP_NODES.map((n) => (n.id === "s-web" ? { ...n, purpose: "Talks to [the API](#node:system:API) as decided in [ADR 1](#adr:1)" } : n));
    const r = open("/t/AA/map?node=s-web", (s) => s.on("GET /api/app/teams/AA/graph", graph("AA", { nodes })));
    const user = userEvent.setup();
    const p = await panel();
    await user.click(within(p).getByRole("link", { name: "the API" }));
    await waitFor(() => expect(within(sideOf()!).getByRole("heading", { level: 2, name: "API" })).toBeTruthy());
    await user.click(within(sideOf()!).getByRole("button", { name: "Close" }));
    expect(r.router.state.location.pathname).toBe("/t/AA/map");
  });

  test("a term in an explanation is underlined with its definition on hover", async () => {
    const nodes = MAP_NODES.map((n) => (n.id === "s-web" ? { ...n, purpose: "Shows every Invoice" } : n));
    open("/t/AA/map?node=s-web", (s) => s.on("GET /api/app/teams/AA/graph", graph("AA", { nodes })));
    const p = await panel();
    const term = within(p).getByText("Invoice");
    expect(term.tagName).toBe("ABBR");
    await userEvent.setup().hover(term);
    expect(await screen.findByText("A bill we send")).toBeTruthy();
  });
});

describe("adding", () => {
  test("+ Add asks for a name and creates a node on the current layer, then opens it", async () => {
    const created = mapNode({ id: "s-new", name: "Queue", layer: "system" });
    const { server } = open("/t/AA/map", (s) => s.on("PUT /api/app/teams/AA/nodes", { node: created }));
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "+ Add" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("New service")).toBeTruthy();
    await user.type(within(dialog).getByPlaceholderText("Name"), "Queue");
    await user.click(within(dialog).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(server.sent("PUT /api/app/teams/AA/nodes")).toHaveLength(1));
    expect(server.sent("PUT /api/app/teams/AA/nodes")[0].body).toEqual({ name: "Queue", layer: "system", parent: null });
  });

  test("on the code layer the name is the path and becomes the anchor; in a container the new node is nested", async () => {
    const { server } = open("/t/AA/map?lens=code", (s) => s.on("PUT /api/app/teams/AA/nodes", { node: mapNode({ id: "k-x", name: "src/x.ts", layer: "code" }) }));
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "+ Add" }));
    await user.type(within(await screen.findByRole("dialog")).getByPlaceholderText("Name"), "src/x.ts");
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(server.sent("PUT /api/app/teams/AA/nodes")).toHaveLength(1));
    expect(server.sent("PUT /api/app/teams/AA/nodes")[0].body).toEqual({ name: "src/x.ts", layer: "code", parent: null, anchors: ["src/x.ts"] });
  });

  test("a refusal (a name that exists on several layers, a rule of the map) shows in the banner", async () => {
    open("/t/AA/map", (s) => s.on("PUT /api/app/teams/AA/nodes", apiError(400, "invalid", '"Queue" exists on several layers; pass layer')));
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "+ Add" }));
    await user.type(within(await screen.findByRole("dialog")).getByPlaceholderText("Name"), "Queue");
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Create" }));
    expect(await screen.findByText('"Queue" exists on several layers; pass layer')).toBeTruthy();
  });
});

describe("flows", () => {
  test("the Flows button opens the list with each flow's step count; Play walks through it", async () => {
    open();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /Flows/ }));
    const side = await flowsSide();
    expect(within(side).getByText("Sign in")).toBeTruthy();
    expect(within(side).getByText("How a person gets in")).toBeTruthy();
    await user.click(within(side).getByRole("button", { name: /Sign in/ }));
    expect(await screen.findByText("step 1 of 2")).toBeTruthy();
    expect(screen.getByText("Open the page")).toBeTruthy();
    expect(screen.getByText("app").tagName).toBe("STRONG"); // the step's detail is Markdown
    expect(screen.getByText(/^at/).textContent).toContain("system");
  });

  test("Next, Back and the arrow keys step through; Done and Escape stop; the lens and the panel follow the step", async () => {
    open("/t/AA/map?flow=f1");
    const user = userEvent.setup();
    expect(await screen.findByText("step 1 of 2")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByText("step 2 of 2")).toBeTruthy();
    await waitFor(() => expect(within(sideOf()!).getByRole("heading", { level: 2, name: "Auth" })).toBeTruthy());
    await user.keyboard("{ArrowLeft}");
    expect(await screen.findByText("step 1 of 2")).toBeTruthy();
    await user.keyboard("{ArrowRight}");
    expect(await screen.findByText("step 2 of 2")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Done" })).toBeTruthy();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByText("step 2 of 2")).toBeNull());
  });

  test("New flow needs a name and, for each step, a place and a title; it saves the steps in order", async () => {
    const { server } = open("/t/AA/map?node=s-web", (s) => s.on("PUT /api/app/teams/AA/flows", { flow: { id: "f2", name: "Pay", description: "", version: 1, steps: [{ nodeId: "s-web", title: "Click pay", detail: "" }] } }));
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /Flows/ }));
    await user.click(await screen.findByRole("button", { name: "+ New flow" }));
    const dialog = await screen.findByRole("dialog");
    const save = within(dialog).getByRole("button", { name: "Save flow" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    await user.type(within(dialog).getByPlaceholderText(/User signs up/), "Pay");
    expect(save.disabled).toBe(true); // the first step (the selected node) has no title yet
    await user.type(within(dialog).getByPlaceholderText("What happens (short)"), "Click pay");
    expect(save.disabled).toBe(false);
    await user.click(save);
    await waitFor(() => expect(server.sent("PUT /api/app/teams/AA/flows")).toHaveLength(1));
    expect(server.sent("PUT /api/app/teams/AA/flows")[0].body).toEqual({ name: "Pay", description: "", steps: [{ node: "s-web", title: "Click pay", detail: "" }] });
  });

  test("Edit opens an existing flow and saves it against its version; a stale save shows the server's message", async () => {
    const { server } = open("/t/AA/map", (s) => s.on("PUT /api/app/teams/AA/flows", apiError(409, "conflict", 'Flow "Sign in" was changed (version 3, you had 2). Re-read and retry.', { current: { id: "f1", version: 3 } })));
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /Flows/ }));
    const side = await flowsSide();
    await user.click(within(side).getByRole("button", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Edit flow")).toBeTruthy();
    await user.type(within(dialog).getByPlaceholderText(/User signs up/), " now");
    await user.click(within(dialog).getByRole("button", { name: "Save flow" }));
    await waitFor(() => expect(server.sent("PUT /api/app/teams/AA/flows")).toHaveLength(1));
    const body = server.sent("PUT /api/app/teams/AA/flows")[0].body as { id: string; version: number; name: string; steps: unknown[] };
    expect([body.id, body.version, body.name, body.steps.length]).toEqual(["f1", 2, "Sign in now", 2]);
    expect(await screen.findByText('Flow "Sign in" was changed (version 3, you had 2). Re-read and retry.')).toBeTruthy();
  });

  test("Delete flow asks first", async () => {
    const { server } = open("/t/AA/map", (s) => s.on("DELETE /api/app/teams/AA/flows/f1", { ok: true }));
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /Flows/ }));
    await user.click(within(await flowsSide()).getByRole("button", { name: "Edit" }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Delete flow" }));
    const ask = await screen.findByRole("alertdialog");
    expect(within(ask).getByText("Delete flow “Sign in”?")).toBeTruthy();
    await user.click(within(ask).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(server.sent("DELETE /api/app/teams/AA/flows/f1")).toHaveLength(1));
  });

  test("with no flows the list says what flows are for", async () => {
    open("/t/AA/map", (s) => s.on("GET /api/app/teams/AA/graph", graph("AA", { flows: [] })));
    await userEvent.setup().click(await screen.findByRole("button", { name: /Flows/ }));
    expect(await screen.findByText(/Flows are step-by-step walks through the map/)).toBeTruthy();
  });
});

describe("Ask the map", () => {
  const ask = async (user: ReturnType<typeof userEvent.setup>, question: string) => {
    await user.click(await screen.findByRole("button", { name: "Ask" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByPlaceholderText("Ask about the system…"), question);
    await user.click(within(dialog).getByRole("button", { name: "Ask" }));
    return dialog;
  };

  test("a question goes to the server (never to Claude directly), and the answer is shown as Markdown with node links", async () => {
    const { server } = open("/t/AA/map", (s) => s.on("POST /api/app/teams/AA/ask", { answer: "The **API** is [[system:API]]", truncated: false }));
    const dialog = await ask(userEvent.setup(), "What is this?");
    expect(await within(dialog).findByText("API", { selector: "strong" })).toBeTruthy();
    expect(within(dialog).getByRole("link", { name: /API/ })).toBeTruthy();
    expect(server.sent("POST /api/app/teams/AA/ask")[0].body).toEqual({ question: "What is this?" });
    // the page only ever talks to this server's own API
    expect(server.requests.every((r) => r.split(" ")[1].startsWith("/api/"))).toBe(true);
  });

  test("asking about a node names it, and passes it as the focus", async () => {
    const { server } = open("/t/AA/map?node=s-web", (s) => s.on("POST /api/app/teams/AA/ask", { answer: "ok", truncated: false }));
    const user = userEvent.setup();
    const p = await panel();
    await user.click(within(p).getByRole("button", { name: /Ask/ }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Ask the map about Web")).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: "What does Web do and why does it exist?" }));
    await waitFor(() => expect(server.sent("POST /api/app/teams/AA/ask")).toHaveLength(1));
    expect(server.sent("POST /api/app/teams/AA/ask")[0].body).toEqual({ question: "What does Web do and why does it exist?", focus: "s-web" });
  });

  test("a cut-off answer says so; a failure shows the server's plain reason", async () => {
    let n = 0;
    open("/t/AA/map", (s) => s.on("POST /api/app/teams/AA/ask", () => (++n === 1 ? { answer: "Partial", truncated: true } : apiError(400, "invalid", "Claude is rate limited, try again in a moment"))));
    const user = userEvent.setup();
    const dialog = await ask(user, "first");
    expect(await within(dialog).findByText("(answer was cut off)")).toBeTruthy();
    await user.type(within(dialog).getByPlaceholderText("Ask about the system…"), "second");
    await user.click(within(dialog).getByRole("button", { name: "Ask" }));
    expect(await within(dialog).findByText("Claude is rate limited, try again in a moment")).toBeTruthy();
  });

  test("too many questions is shown as the server says it", async () => {
    open("/t/AA/map", (s) => s.on("POST /api/app/teams/AA/ask", apiError(429, "rate_limited", "Too many attempts. Try again in 10 minutes.", undefined, { "retry-after": "600" })));
    const dialog = await ask(userEvent.setup(), "again");
    expect(await within(dialog).findByText("Too many attempts. Try again in 10 minutes.")).toBeTruthy();
  });

  test("when Ask is off on this server it says how to turn it on and does not let you ask", async () => {
    open("/t/AA/map", (s) => s.on("GET /api/app/teams/AA/graph", graph("AA", { askEnabled: false })));
    await userEvent.setup().click(await screen.findByRole("button", { name: "Ask" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/Ask is off\. Set/)).toBeTruthy();
    expect((within(dialog).getByPlaceholderText("Ask about the system…") as HTMLInputElement).disabled).toBe(true);
    expect((within(dialog).getByRole("button", { name: "Ask" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("stale and live", () => {
  test("the stale button filters to stale nodes and says how many", async () => {
    open();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "1 stale" }));
    expect(await screen.findByText("Showing 1 stale node(s): their code changed since they were described")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "1 stale" }));
    await waitFor(() => expect(screen.queryByText(/Showing 1 stale/)).toBeNull());
  });

  test("a change by an agent appears over the live stream, and the open panel stays open", async () => {
    let nodes = MAP_NODES;
    open("/t/AA/map?node=s-web", (s) => s.on("GET /api/app/teams/AA/graph", () => graph("AA", { nodes })));
    await panel();
    await waitFor(() => expect(FakeEventSource.open.length).toBe(1));
    nodes = [...MAP_NODES, mapNode({ id: "s-new", name: "Brand new service", layer: "system", x: 900, y: 60 })];
    act(() => FakeEventSource.open[0].emit("change", { seq: 7 }));
    await waitFor(() => expect(nodeEl("Brand new service")).toBeTruthy());
    expect(sideOf()!).toBeTruthy();
    await settled();
    expect(mapNodes().filter((n) => n.textContent?.includes("Brand new service"))).toHaveLength(1);
  });

  test("the address follows where you are (lens, node, flow) so a link can be shared", async () => {
    open("/t/AA/map");
    const user = userEvent.setup();
    await user.click(await tab(/Data/));
    await waitFor(() => expect(window.location.search).toContain("lens=data"));
    await click(user, "users");
    await waitFor(() => expect(window.location.search).toContain("node=d-users"));
  });

  test("the Tidy button on the data layer arranges the tables and saves them as not placed by hand", async () => {
    const { server } = open("/t/AA/map?lens=data", (s) => s.on("PUT /api/app/teams/AA/layout", { ok: true }));
    await userEvent.setup().click(await screen.findByRole("button", { name: "Tidy" }));
    await waitFor(() => expect(server.sent("PUT /api/app/teams/AA/layout")).toHaveLength(1));
    const body = server.sent("PUT /api/app/teams/AA/layout")[0].body as { positions: { id: string; x: number; y: number }[]; placed: boolean };
    expect(body.placed).toBe(false);
    expect(body.positions.map((p) => p.id).sort()).toEqual(["d-posts", "d-users"]);
    expect(body.positions.every((p) => Number.isInteger(p.x) && Number.isInteger(p.y))).toBe(true);
  });
});
