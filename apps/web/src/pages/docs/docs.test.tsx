import { afterEach, describe, expect, test, vi } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DOC_TEMPLATES } from "@wheelhouse/core/lib/doc-templates";
import { apiError, renderApp, type FakeServer } from "../../test/harness";
import { doc, docDetail, DOCS, docsIndex, repo } from "../../test/data";
import { FakeEventSource } from "../../test/fake-event-source";

afterEach(() => localStorage.clear());

const open = (path = "/p/AA/docs", setup: (s: FakeServer) => unknown = () => {}) => renderApp(path, setup);
const row = async (title: string) => screen.findByRole("button", { name: new RegExp(`^(⚠)?${title}$`) });
/** The doc's own title (the page's h1; the text can have an h1 of its own too). */
const heading = (title: string) => waitFor(() => expect(document.querySelector("h1.text-3xl")?.textContent).toBe(title));
const url = (path: string) => `/api/app/projects/AA/${path}`;
/** Serve a doc (and the index with it), so a test can make it a different one. */
const serve = (s: FakeServer, docs = DOCS, nodes: Parameters<typeof docDetail>[1] = []) => {
  s.on(`GET ${url("docs")}`, docsIndex(docs));
  for (const d of docs) s.on(`GET ${url(`docs/${d.id}`)}`, docDetail(d, nodes));
};
const bodyBox = () => document.querySelector("textarea") as HTMLTextAreaElement;

describe("the tree", () => {
  test("lists docs nested under their parents, with a warning on the stale ones; the first is open", async () => {
    open();
    await heading("Plan");
    expect(await row("Plan")).toBeTruthy();
    expect(await row("Phase 1")).toBeTruthy();
    const api = screen.getByRole("button", { name: /API notes/ });
    expect(within(api).getByTitle("Possibly out of date")).toBeTruthy();
    const phase = screen.getByRole("button", { name: "Phase 1" });
    expect(phase.closest("ul")!.className).toContain("border-l"); // nested
    expect(screen.getByRole("button", { name: "Plan" }).getAttribute("aria-current")).toBe("true");
  });

  test("clicking another doc opens it", async () => {
    open();
    const user = userEvent.setup();
    await user.click(await row("Phase 1"));
    await heading("Phase 1");
    expect(await screen.findByText("Phase one.")).toBeTruthy();
  });

  test("with no docs it says so, and offers to create one", async () => {
    open("/p/AA/docs", (s) => s.on(`GET ${url("docs")}`, docsIndex([])));
    await screen.findByText("No docs yet. Create one to get started.");
    expect(screen.getByText("Select a doc, or create one.")).toBeTruthy();
    expect(screen.queryByLabelText("Filter docs by title")).toBeNull();
  });

  test("the search box filters to a flat list by title and says when nothing matches", async () => {
    open();
    const user = userEvent.setup();
    await row("Plan");
    await user.type(screen.getByLabelText("Filter docs by title"), "phase");
    expect(screen.queryByRole("button", { name: "Plan" })).toBeNull();
    expect(screen.getByRole("button", { name: "Phase 1" }).closest("ul")!.className).not.toContain("border-l"); // flat
    await user.clear(screen.getByLabelText("Filter docs by title"));
    await user.type(screen.getByLabelText("Filter docs by title"), "zzz");
    expect(screen.getByText('No docs match "zzz".')).toBeTruthy();
  });
});

describe("reading a doc", () => {
  test("the body is Markdown, with who changed it, whether it is up to date, reading time, words, the slug and version", async () => {
    open();
    await heading("Plan");
    const content = document.querySelector(".md-quiet") as HTMLElement;
    expect(within(content).getByText("soon").tagName).toBe("STRONG");
    expect(screen.getByText("By Ada Lovelace")).toBeTruthy();
    expect(screen.getByText("Up to date")).toBeTruthy();
    expect(screen.getByText("📖 1 min read")).toBeTruthy();
    expect(screen.getByText("5 words")).toBeTruthy();
    expect(screen.getByText("plan · v1")).toBeTruthy();
  });

  test("a doc an agent wrote says 'Agent'; one by someone who left says 'Someone'", async () => {
    open("/p/AA/docs", (s) => serve(s, [doc({ updatedByKind: "agent", updatedById: null })]));
    await screen.findByText("By Agent");
    const { unmount } = open("/p/AA/docs", (s) => serve(s, [doc({ updatedById: "gone" })]));
    unmount();
    open("/p/AA/docs", (s) => serve(s, [doc({ updatedById: "gone" })]));
    expect((await screen.findAllByText("By Someone")).length).toBeGreaterThan(0);
  });

  test("HTML in a doc is not rendered", async () => {
    open("/p/AA/docs", (s) => serve(s, [doc({ body: "hello <script>alert(1)</script> <b>bold</b>" })]));
    await heading("Plan");
    expect(document.querySelector(".md-quiet script")).toBeNull();
    expect(document.querySelector(".md-quiet b")).toBeNull();
  });

  test("a stale doc says why, and 'Confirm accurate' clears it", async () => {
    const { server } = open("/p/AA/docs", (s) => {
      serve(s);
      s.on(`POST ${url("docs/d-api/fresh")}`, { doc: doc({ id: "d-api" }) });
    });
    const user = userEvent.setup();
    await user.click(await row("API notes").catch(() => screen.findByRole("button", { name: /API notes/ })));
    const banner = await screen.findByText(/Possibly out of date: src\/lib\/service\.ts changed in abc1234/);
    expect(banner.textContent).toContain("Edit the content to refresh it, or confirm it's still accurate.");
    expect(screen.getByText("Possibly out of date", { selector: "span *, span" })).toBeTruthy();
    await user.click(within(banner).getByRole("button", { name: "Confirm accurate" }));
    await waitFor(() => expect(server.sent(`POST ${url("docs/d-api/fresh")}`)).toHaveLength(1));
    expect(server.sent(`POST ${url("docs/d-api/fresh")}`)[0].headers["x-csrf-token"]).toBe("csrf-ada");
  });

  test("Copy for agent puts @doc:slug on the clipboard", async () => {
    open();
    const user = userEvent.setup();
    const write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    await user.click(await screen.findByRole("button", { name: "Copy for agent" }));
    expect(write).toHaveBeenCalledWith("@doc:plan");
    expect(await screen.findByRole("button", { name: "Copied!" })).toBeTruthy();
  });

  test("a doc that cannot be read says so instead of an empty page", async () => {
    open("/p/AA/docs", (s) => {
      serve(s);
      s.on(`GET ${url("docs/d-plan")}`, apiError(404, "not_found", 'Doc "d-plan" not found'));
    });
    expect(await screen.findByText('Doc "d-plan" not found')).toBeTruthy();
  });
});

describe("creating", () => {
  test("+ Create offers Blank and the five templates", async () => {
    open();
    await userEvent.setup().click(await screen.findByRole("button", { name: "+ Create" }));
    const dialog = await screen.findByRole("dialog", { name: "New doc" });
    expect(within(dialog).getByRole("button", { name: /^Blank/ })).toBeTruthy();
    for (const t of DOC_TEMPLATES) expect(within(dialog).getByRole("button", { name: new RegExp(`^${t.name.replace(/[/()]/g, ".")}`) })).toBeTruthy();
    expect(DOC_TEMPLATES).toHaveLength(5);
  });

  test("a blank doc is created as 'Untitled doc' and opens straight in the editor", async () => {
    const created = doc({ id: "d-new", title: "Untitled doc", slug: "untitled-doc", body: "", version: 1 });
    const { server } = open("/p/AA/docs", (s) => {
      s.on(`POST ${url("docs")}`, () => Response.json({ doc: created }, { status: 201 }));
      s.on(`GET ${url("docs/d-new")}`, docDetail(created));
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "+ Create" }));
    await user.click(await screen.findByRole("button", { name: /^Blank/ }));
    await waitFor(() => expect(server.sent(`POST ${url("docs")}`)).toHaveLength(1));
    expect(server.sent(`POST ${url("docs")}`)[0].body).toEqual({ title: "Untitled doc", parent: null });
    expect((await screen.findByLabelText("Title") as HTMLInputElement).value).toBe("Untitled doc");
    expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "New doc" })).toBeNull();
  });

  test.each(DOC_TEMPLATES.map((t) => [t.id, t.name, t.body] as const))("from the %s template: the title is the template's name and the body comes from it", async (id, name, templateBody) => {
    const created = doc({ id: "d-t", title: name, slug: id, body: templateBody });
    const { server } = open("/p/AA/docs", (s) => {
      s.on(`POST ${url("docs")}`, () => Response.json({ doc: created }, { status: 201 }));
      s.on(`GET ${url("docs/d-t")}`, docDetail(created));
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "+ Create" }));
    await user.click(await screen.findByRole("button", { name: new RegExp(`^${name.replace(/[/()]/g, ".")}`) }));
    await waitFor(() => expect(server.sent(`POST ${url("docs")}`)).toHaveLength(1));
    expect(server.sent(`POST ${url("docs")}`)[0].body).toEqual({ title: name, parent: null, template: id });
    expect((await screen.findByLabelText("Title") as HTMLInputElement).value).toBe(name);
  });

  test("a refusal is shown and nothing is opened", async () => {
    open("/p/AA/docs", (s) => s.on(`POST ${url("docs")}`, apiError(400, "invalid", "Docs can nest at most 4 levels deep")));
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "+ Create" }));
    await user.click(await screen.findByRole("button", { name: /^Blank/ }));
    expect(await screen.findByText("Docs can nest at most 4 levels deep")).toBeTruthy();
  });
});

describe("editing", () => {
  test("Edit shows the title and body; Save sends only what changed, with the version the doc was read at", async () => {
    const { server } = open("/p/AA/docs", (s) => s.on(`PATCH ${url("docs/d-plan")}`, { doc: doc({ version: 2 }) }));
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "✎ Edit" }));
    const title = screen.getByLabelText("Title") as HTMLInputElement;
    expect(title.value).toBe("Plan");
    await user.click(screen.getByRole("button", { name: "Markdown" }));
    expect(bodyBox().value).toBe("# Plan\n\nWe ship **soon**.");
    await user.clear(title);
    await user.type(title, "Plan v2");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(server.sent(`PATCH ${url("docs/d-plan")}`)).toHaveLength(1));
    expect(server.sent(`PATCH ${url("docs/d-plan")}`)[0].body).toEqual({ title: "Plan v2", version: 1 });
    await waitFor(() => expect(screen.queryByLabelText("Title")).toBeNull()); // back to reading
  });

  test("editing the text sends the body", async () => {
    const { server } = open("/p/AA/docs", (s) => s.on(`PATCH ${url("docs/d-plan")}`, { doc: doc({ version: 2 }) }));
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "✎ Edit" }));
    await user.click(screen.getByRole("button", { name: "Markdown" }));
    await user.clear(bodyBox());
    await user.type(bodyBox(), "Shipped.");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(server.sent(`PATCH ${url("docs/d-plan")}`)).toHaveLength(1));
    expect(server.sent(`PATCH ${url("docs/d-plan")}`)[0].body).toEqual({ body: "Shipped.", version: 1 });
  });

  test("Save with nothing changed sends nothing", async () => {
    const { server } = open();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "✎ Edit" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByLabelText("Title")).toBeNull());
    expect(server.sent(`PATCH ${url("docs/d-plan")}`)).toHaveLength(0);
  });

  test("Cancel leaves the doc as it was", async () => {
    const { server } = open();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "✎ Edit" }));
    await user.type(screen.getByLabelText("Title"), " changed");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await heading("Plan");
    expect(server.sent(`PATCH ${url("docs/d-plan")}`)).toHaveLength(0);
  });

  test("a doc with no text opens straight in the editor", async () => {
    open("/p/AA/docs", (s) => serve(s, [doc({ body: "" })]));
    expect(await screen.findByRole("button", { name: "Save" })).toBeTruthy();
  });

  test("someone else saved first: the banner says the doc moved on, and the save is refused with the server's words, nothing overwritten", async () => {
    let served = doc();
    const conflict = apiError(409, "conflict", 'Doc "Plan" was changed (version 2, you had 1). Re-read and retry.', { current: doc({ version: 2, body: "Theirs" }) });
    const { server } = open("/p/AA/docs", (s) => {
      s.on(`GET ${url("docs/d-plan")}`, () => docDetail(served));
      s.on(`PATCH ${url("docs/d-plan")}`, conflict);
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "✎ Edit" }));
    await user.click(screen.getByRole("button", { name: "Markdown" }));
    await user.type(bodyBox(), " mine");
    served = doc({ version: 2, body: "Theirs" });
    act(() => FakeEventSource.open[0].emit("change", { seq: 3 }));
    expect(await screen.findByText(/This doc changed while you were editing \(now v2\)\. Saving will be refused/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText('Doc "Plan" was changed (version 2, you had 1). Re-read and retry.')).toBeTruthy();
    expect(server.sent(`PATCH ${url("docs/d-plan")}`)[0].body).toMatchObject({ version: 1 });
    expect(bodyBox().value).toContain("mine"); // what was typed is still there to copy
    expect(screen.getByRole("button", { name: "Save" })).toBeTruthy(); // still editing
  });
});

describe("attached files (anchors)", () => {
  test("in the editor: type a path and press Enter, remove one, and Save sends the list", async () => {
    const { server } = open("/p/AA/docs", (s) => s.on(`PATCH ${url("docs/d-plan")}`, { doc: doc({ version: 2 }) }));
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "✎ Edit" }));
    await user.type(screen.getByPlaceholderText("src/lib/x.ts"), "src/a.ts{Enter}src/b.ts{Enter}");
    expect(screen.getByRole("button", { name: "Remove anchor src/a.ts" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Remove anchor src/a.ts" }));
    await user.type(screen.getByPlaceholderText("src/lib/x.ts"), "src/b.ts{Enter}"); // a duplicate is ignored
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(server.sent(`PATCH ${url("docs/d-plan")}`)).toHaveLength(1));
    expect(server.sent(`PATCH ${url("docs/d-plan")}`)[0].body).toEqual({ anchors: ["src/b.ts"], version: 1 });
  });

  test("Suggest offers paths from the text and the linked nodes; clicking one adds it", async () => {
    open("/p/AA/docs", (s) => s.on(`GET ${url("docs/d-plan/anchor-suggestions")}`, { anchors: ["src/lib/service.ts", "apps/api/**"] }));
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "✎ Edit" }));
    await user.click(screen.getByRole("button", { name: "Suggest" }));
    await user.click(await screen.findByRole("button", { name: "+ src/lib/service.ts" }));
    expect(screen.getByRole("button", { name: "Remove anchor src/lib/service.ts" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "+ src/lib/service.ts" })).toBeNull(); // no longer offered
    expect(screen.getByRole("button", { name: "+ apps/api/**" })).toBeTruthy();
  });

  test("Browse repo shows the connected repository's files as folders; a filter opens the matching ones; clicking a file adds it", async () => {
    open("/p/AA/docs", (s) => {
      s.on(`GET ${url("repositories")}`, { repositories: [repo({ id: "r-gh", displayName: "app", provider: "github", browsable: true })] });
      s.on(`GET ${url("repositories/r-gh/tree")}`, { files: ["README.md", "src/lib/a.ts", "src/lib/b.ts", "docs/guide.md"], truncated: false });
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "✎ Edit" }));
    await user.click(await screen.findByRole("button", { name: /Browse repo/ }));
    const dialog = await screen.findByRole("dialog", { name: "Browse repo" });
    expect(await within(dialog).findByText("README.md")).toBeTruthy();
    expect(within(dialog).queryByText("a.ts")).toBeNull(); // folders start closed
    await user.type(within(dialog).getByLabelText("Filter repo files"), "a.ts");
    await user.click(await within(dialog).findByTitle("src/lib/a.ts"));
    expect(within(dialog).queryByText("b.ts")).toBeNull();
    await user.click(within(dialog).getByRole("button", { name: "Done" }));
    expect(screen.getByRole("button", { name: "Remove anchor src/lib/a.ts" })).toBeTruthy();
  });

  test("Browse repo is offered only when a GitHub repository is connected; a failure and an empty repository are said plainly", async () => {
    const { unmount } = open();
    await userEvent.setup().click(await screen.findByRole("button", { name: "✎ Edit" }));
    expect(screen.queryByRole("button", { name: /Browse repo/ })).toBeNull();
    unmount();
    open("/p/AA/docs", (s) => {
      s.on(`GET ${url("repositories")}`, { repositories: [repo({ id: "r-gh", provider: "github", browsable: true })] });
      s.on(`GET ${url("repositories/r-gh/tree")}`, apiError(400, "invalid", "GitHub is not set up on this server"));
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "✎ Edit" }));
    await user.click(await screen.findByRole("button", { name: /Browse repo/ }));
    expect(await screen.findByText("GitHub is not set up on this server")).toBeTruthy();
  });

  test("with several GitHub repositories the dialog lets you pick which to browse", async () => {
    open("/p/AA/docs", (s) => {
      s.on(`GET ${url("repositories")}`, {
        repositories: [repo({ id: "r1", displayName: "web", provider: "github", browsable: true }), repo({ id: "r2", displayName: "api", provider: "github", browsable: true })],
      });
      s.on(`GET ${url("repositories/r1/tree")}`, { files: ["web.txt"], truncated: false });
      s.on(`GET ${url("repositories/r2/tree")}`, { files: ["api.txt"], truncated: false });
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "✎ Edit" }));
    await user.click(await screen.findByRole("button", { name: /Browse repo/ }));
    const dialog = await screen.findByRole("dialog", { name: "Browse repo" });
    expect(await within(dialog).findByText("web.txt")).toBeTruthy();
    await user.click(within(dialog).getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: "api" }));
    expect(await within(dialog).findByText("api.txt")).toBeTruthy();
  });

  test("a doc's attached files are listed when reading", async () => {
    open("/p/AA/docs", (s) => serve(s, [doc({ anchors: ["src/a.ts", "docs/**"] })]));
    const section = (await screen.findAllByText("Attached files"))[0].closest("section") as HTMLElement;
    expect(within(section).getByText("src/a.ts")).toBeTruthy();
    expect(within(section).getByText("docs/**")).toBeTruthy();
  });
});

describe("action items", () => {
  const withItems = doc({ body: "## Action items\n- [ ] Write the runbook\n- [x] Done already\n- [ ] Ask legal\n" });

  test("each unchecked item can become a ticket; the box is then checked in the doc, against the version that was read", async () => {
    const { server } = open("/p/AA/docs", (s) => {
      serve(s, [withItems]);
      s.on(`POST ${url("tickets")}`, () => Response.json({ ticket: { ref: "AA-5", title: "Write the runbook" } }, { status: 201 }));
      s.on(`PATCH ${url("docs/d-plan")}`, { doc: doc({ version: 2 }) });
    });
    const user = userEvent.setup();
    const section = (await screen.findByText("Action items", { selector: "span.label" })).closest("section") as HTMLElement;
    expect(within(section).getAllByRole("button", { name: "Create ticket" })).toHaveLength(2); // the checked one is not offered
    await user.click(within(section).getAllByRole("button", { name: "Create ticket" })[0]);
    await waitFor(() => expect(server.sent(`POST ${url("tickets")}`)).toHaveLength(1));
    expect(server.sent(`POST ${url("tickets")}`)[0].body).toEqual({ title: "Write the runbook" });
    await waitFor(() => expect(server.sent(`PATCH ${url("docs/d-plan")}`)).toHaveLength(1));
    expect(server.sent(`PATCH ${url("docs/d-plan")}`)[0].body).toEqual({ body: "## Action items\n- [x] Write the runbook\n- [x] Done already\n- [ ] Ask legal\n", version: 1 });
  });

  test("if the ticket cannot be made the box stays unchecked and the reason is shown", async () => {
    const { server } = open("/p/AA/docs", (s) => {
      serve(s, [withItems]);
      s.on(`POST ${url("tickets")}`, apiError(400, "invalid", "title is required"));
    });
    const user = userEvent.setup();
    await user.click((await screen.findAllByRole("button", { name: "Create ticket" }))[0]);
    expect(await screen.findByText("title is required")).toBeTruthy();
    expect(server.sent(`PATCH ${url("docs/d-plan")}`)).toHaveLength(0);
  });
});

describe("decision records", () => {
  const record = doc({ id: "d-rec", slug: "rec", title: "Decision record", body: "# Decision: Use REST\n\n## Context\nWe need one protocol, in Zurich.\n\n## Decision\nREST over HTTP.\n\n## Consequences\nNo streaming.\n" });
  const createRecord = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(await screen.findByRole("button", { name: "+ Create" }));
    await user.click(await screen.findByRole("button", { name: /^Decision record/ }));
    await user.click(await screen.findByRole("button", { name: "Save" }));
  };

  test("a doc just made from the decision-record template offers to link an ADR or make one from its sections", async () => {
    const { server, at } = open("/p/AA/docs", (s) => {
      s.on(`POST ${url("docs")}`, () => Response.json({ doc: record }, { status: 201 }));
      s.on(`GET ${url("docs/d-rec")}`, docDetail(record));
      s.on(`PUT ${url("decisions")}`, { decision: { id: "dec9", number: 9 } });
    });
    const user = userEvent.setup();
    await createRecord(user);
    const section = (await screen.findByText("Decision record", { selector: "span.label" })).closest("section") as HTMLElement;
    expect(within(section).getByRole("link", { name: "View all decisions →" }).getAttribute("href")).toBe("/p/AA/decisions");
    await user.click(within(section).getByRole("button", { name: "+ Create ADR from this doc" }));
    await waitFor(() => expect(server.sent(`PUT ${url("decisions")}`)).toHaveLength(1));
    expect(server.sent(`PUT ${url("decisions")}`)[0].body).toEqual({
      title: "Decision record",
      status: "proposed",
      context: "We need one protocol, in Zurich.",
      decision: "REST over HTTP.",
      consequences: "No streaming.",
    });
    await waitFor(() => expect(at()).toBe("/p/AA/decisions"));
  });

  test("an existing ADR can be linked instead", async () => {
    const { at } = open("/p/AA/docs", (s) => {
      s.on(`POST ${url("docs")}`, () => Response.json({ doc: record }, { status: 201 }));
      s.on(`GET ${url("docs/d-rec")}`, docDetail(record));
    });
    const user = userEvent.setup();
    await createRecord(user);
    const section = (await screen.findByText("Decision record", { selector: "span.label" })).closest("section") as HTMLElement;
    await user.click(within(section).getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: "ADR-1: Use REST" }));
    await waitFor(() => expect(at()).toBe("/p/AA/decisions"));
  });

  test("an ordinary doc does not offer it", async () => {
    open();
    await heading("Plan");
    expect(screen.queryByText("Decision record", { selector: "span.label" })).toBeNull();
  });
});

describe("moving, linking and deleting", () => {
  test("Move puts a doc under another, or back at the top, with the version", async () => {
    const { server } = open("/p/AA/docs", (s) => s.on(`POST ${url("docs/d-plan/move")}`, { doc: doc() }));
    const user = userEvent.setup();
    const section = (await screen.findByText("Move", { selector: "span.label" })).closest("section") as HTMLElement;
    await user.click(within(section).getByRole("combobox"));
    expect(screen.queryByRole("option", { name: "Plan" })).toBeNull(); // not under itself
    await user.click(await screen.findByRole("option", { name: "API notes" }));
    await waitFor(() => expect(server.sent(`POST ${url("docs/d-plan/move")}`)).toHaveLength(1));
    expect(server.sent(`POST ${url("docs/d-plan/move")}`)[0].body).toEqual({ parent: "d-api", version: 1 });
  });

  test("a move the server refuses is shown", async () => {
    open("/p/AA/docs", (s) => s.on(`POST ${url("docs/d-plan/move")}`, apiError(400, "invalid", "Can't move a doc under one of its own descendants")));
    const user = userEvent.setup();
    const section = (await screen.findByText("Move", { selector: "span.label" })).closest("section") as HTMLElement;
    await user.click(within(section).getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: "Phase 1" }));
    expect(await screen.findByText("Can't move a doc under one of its own descendants")).toBeTruthy();
  });

  test("Architecture shows the nodes a doc is linked to; one can be unlinked, another linked", async () => {
    const { server } = open("/p/AA/docs", (s) => {
      serve(s, DOCS, [{ id: "s-api", name: "API", kind: "service", layer: "system" }]);
      s.on(`DELETE ${url("docs/d-plan/nodes/s-api")}`, { ok: true });
      s.on(`PUT ${url("docs/d-plan/nodes/c-bill")}`, { ok: true });
    });
    const user = userEvent.setup();
    expect(await screen.findByText("◇ system:API")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Unlink API" }));
    await waitFor(() => expect(server.sent(`DELETE ${url("docs/d-plan/nodes/s-api")}`)).toHaveLength(1));
    const section = (await screen.findByText("Architecture", { selector: "span.label" })).closest("section") as HTMLElement;
    await user.click(within(section).getByRole("combobox"));
    expect(screen.queryByRole("option", { name: "system: API" })).toBeNull(); // already linked
    await user.click(await screen.findByRole("option", { name: "concept: Billing" }));
    await waitFor(() => expect(server.sent(`PUT ${url("docs/d-plan/nodes/c-bill")}`)).toHaveLength(1));
  });

  test("with an empty map it says so", async () => {
    open("/p/AA/docs", (s) => s.on(`GET ${url("docs")}`, docsIndex(DOCS, { nodes: [] })));
    expect(await screen.findByText("No nodes on the map yet.")).toBeTruthy();
  });

  test("Delete asks first and says the nested docs go too; then the doc is gone from the tree", async () => {
    let docs = DOCS;
    const { server } = open("/p/AA/docs", (s) => {
      s.on(`GET ${url("docs")}`, () => docsIndex(docs));
      s.on(`GET ${url("docs/d-plan")}`, docDetail(DOCS[0]));
      s.on(`DELETE ${url("docs/d-plan")}`, () => ((docs = docs.filter((d) => d.id !== "d-plan" && d.parentId !== "d-plan")), { ok: true }));
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Delete" }));
    const ask = await screen.findByRole("alertdialog");
    expect(within(ask).getByText('Delete "Plan"?')).toBeTruthy();
    expect(within(ask).getByText("This also removes any nested docs underneath it.")).toBeTruthy();
    await user.click(within(ask).getByRole("button", { name: "Cancel" }));
    expect(server.sent(`DELETE ${url("docs/d-plan")}`)).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "Delete" }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(server.sent(`DELETE ${url("docs/d-plan")}`)).toHaveLength(1));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Phase 1" })).toBeNull());
    expect(await screen.findByText("Select a doc, or create one.")).toBeTruthy();
  });
});

describe("live", () => {
  test("a doc an agent adds appears in the tree over the live stream, without a reload", async () => {
    let docs = DOCS;
    open("/p/AA/docs", (s) => s.on(`GET ${url("docs")}`, () => docsIndex(docs)));
    await row("Plan");
    await waitFor(() => expect(FakeEventSource.open.length).toBe(1));
    docs = [...DOCS, doc({ id: "d-new", slug: "runbook", title: "Runbook", position: 9 })];
    act(() => FakeEventSource.open[0].emit("change", { seq: 5 }));
    expect(await screen.findByRole("button", { name: "Runbook" })).toBeTruthy();
  });

  test("another team's project has no docs page", async () => {
    renderApp("/p/ZZ/docs");
    expect(await screen.findByText(/not found|can.t find|doesn.t exist/i)).toBeTruthy();
  });
});
