import { describe, expect, test } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { apiError, renderApp, type FakeServer } from "../../test/harness";
import { board as makeBoard, detail } from "../../test/data";
import { FakeEventSource } from "../../test/fake-event-source";

const BOARD = makeBoard("AA");
const T2 = BOARD.tickets.find((t) => t.ref === "AA-2")!; // Todo, "Build the board", AI-ready
const T3 = BOARD.tickets.find((t) => t.ref === "AA-3")!; // Todo, "Fix the crash", by an agent

/** A ticket's server-side state: tests change it, and the fake server answers with it. */
function serve(s: FakeServer, over: Partial<typeof T2> = {}) {
  const state = { ticket: { ...T2, ...over }, comments: [] as ReturnType<typeof detail>["comments"], nodes: [] as ReturnType<typeof detail>["nodes"] };
  s.on("GET /api/app/tickets/AA-2", () => detail(state.ticket, { comments: state.comments, nodes: state.nodes }));
  s.on("GET /api/app/tickets/AA-3", detail(T3));
  return state;
}
const dialog = async () => screen.findByRole("dialog");
const open = async (setup: (s: FakeServer) => unknown = () => {}, path = "/p/AA?t=AA-2") => {
  let state!: ReturnType<typeof serve>;
  const r = renderApp(path, (s) => {
    state = serve(s);
    setup(s);
  });
  const d = await dialog();
  await within(d).findByRole("textbox", { name: "Title" });
  return { ...r, d, state };
};
const markdownMode = () => localStorage.setItem("wh:editor-mode", "markdown");
/** The description box when it is in raw Markdown mode (it has no label of its own; the labels field is also a textbox, further on). */
const descriptionBox = (d: HTMLElement) => d.querySelector("textarea.font-mono") as HTMLTextAreaElement;

describe("opening a ticket", () => {
  test("the card opens it, ?t= names it, and the dialog is labelled for screen readers", async () => {
    const r = renderApp("/p/AA", (s) => void serve(s));
    await userEvent.setup().click((await screen.findByText("Build the board")).closest("[data-ticket]") as HTMLElement);
    const d = await dialog();
    expect(r.router.state.location.search).toBe("?t=AA-2");
    expect(d.getAttribute("aria-labelledby")).toBeTruthy();
    // Until the ticket has loaded the title is a placeholder ("Ticket AA-2"); then it is the ref and the title.
    await waitFor(() => expect(document.getElementById(d.getAttribute("aria-labelledby")!)?.textContent).toBe("AA-2: Build the board"));
    expect(d.getAttribute("aria-describedby")).toBeTruthy();
  });

  test("a shared link opens straight onto it; a value that is not a ticket ref opens nothing", async () => {
    await open();
    expect(screen.getByRole("dialog")).toBeTruthy();
    const { unmount } = renderApp("/p/AA?t=<script>", (s) => void serve(s));
    await screen.findAllByText("Write the plan");
    expect(screen.queryAllByRole("dialog").length).toBe(1); // only the first render's
    unmount();
  });

  test("it shows the ref and version, the title, the description as Markdown, discussion, history and the properties", async () => {
    const { d } = await open((s) => {
      serve(s, { body: "Some **bold** words", version: 3 });
      s.on("GET /api/app/tickets/AA-2", detail({ ...T2, body: "Some **bold** words", version: 3 }, { comments: [{ id: "c1", authorKind: "agent", authorName: "CI bot", body: "Looked at `it`", createdAt: new Date().toISOString() }] }));
    });
    expect(within(d).getByText("AA-2", { selector: ".font-mono" })).toBeTruthy();
    expect(within(d).getByText("v3")).toBeTruthy();
    expect((within(d).getByRole("textbox", { name: "Title" }) as HTMLTextAreaElement).value).toBe("Build the board");
    expect(within(d).getByText("bold").tagName).toBe("STRONG");
    expect(within(d).getByText("CI bot")).toBeTruthy();
    expect(within(d).getByText("agent")).toBeTruthy();
    expect(within(d).getByText("Discussion")).toBeTruthy();
    expect(within(d).getByText(/created AA-2/)).toBeTruthy();
    expect(within(d).getByText("Status")).toBeTruthy();
    expect((within(d).getByRole("checkbox") as HTMLInputElement).checked).toBe(true); // AI-ready
  });

  test("an agent-made ticket says so", async () => {
    const { d } = await open(() => {}, "/p/AA?t=AA-3");
    expect(within(d).getByText("created by agent")).toBeTruthy();
  });

  test("a ticket that cannot be loaded says why instead of staying blank", async () => {
    renderApp("/p/AA?t=AA-2", (s) => s.on("GET /api/app/tickets/AA-2", apiError(404, "not_found", "Ticket AA-2 not found")));
    expect(await screen.findByText("Ticket AA-2 not found")).toBeTruthy();
  });

  test("Escape and the ✕ close it and clear ?t=", async () => {
    const r = await open();
    await userEvent.setup().keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(r.router.state.location.search).toBe("");
    r.unmount();
    const r2 = await open();
    await userEvent.setup().click(screen.getByRole("button", { name: "Close ticket" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(r2.router.state.location.search).toBe("");
  });
});

describe("the title", () => {
  test("leaving the title saves it against the version that was read", async () => {
    const { server, d } = await open((s) => s.on("PATCH /api/app/tickets/AA-2", { ticket: { ...T2, title: "Renamed", version: 2 } }));
    const user = userEvent.setup();
    const title = within(d).getByRole("textbox", { name: "Title" });
    await user.clear(title);
    await user.type(title, "Renamed");
    await user.tab();
    await waitFor(() => expect(server.sent("PATCH /api/app/tickets/AA-2")).toHaveLength(1));
    expect(server.sent("PATCH /api/app/tickets/AA-2")[0].body).toEqual({ title: "Renamed", version: 1 });
  });

  test("Enter saves it too, and a line break never gets in", async () => {
    const { server, d } = await open((s) => s.on("PATCH /api/app/tickets/AA-2", { ticket: T2 }));
    const user = userEvent.setup();
    const title = within(d).getByRole("textbox", { name: "Title" }) as HTMLTextAreaElement;
    await user.clear(title);
    await user.type(title, "One line{Enter}");
    await waitFor(() => expect(server.sent("PATCH /api/app/tickets/AA-2")).toHaveLength(1));
    expect(title.value).toBe("One line");
    expect(server.sent("PATCH /api/app/tickets/AA-2")[0].body).toMatchObject({ title: "One line" });
  });

  test("an empty or unchanged title is not sent", async () => {
    const { server, d } = await open();
    const user = userEvent.setup();
    const title = within(d).getByRole("textbox", { name: "Title" });
    await user.click(title);
    await user.tab();
    await user.clear(title);
    await user.tab();
    expect(server.sent("PATCH /api/app/tickets/AA-2")).toHaveLength(0);
  });
});

describe("a stale edit shows the conflict instead of overwriting", () => {
  test("the server refuses, the page shows its message and then the ticket as it is now", async () => {
    const { server, d, state } = await open((s) =>
      s.on("PATCH /api/app/tickets/AA-2", () => apiError(409, "conflict", "AA-2 was changed (version 2, you had 1). Re-read and retry.", { current: { ...T2, title: "Changed meanwhile", version: 2 } })),
    );
    const user = userEvent.setup();
    state.ticket = { ...state.ticket, title: "Changed meanwhile", version: 2 }; // what the server has now
    const title = within(d).getByRole("textbox", { name: "Title" });
    await user.clear(title);
    await user.type(title, "My slow edit");
    await user.tab();
    expect((await within(d).findByRole("alert")).textContent).toBe("AA-2 was changed (version 2, you had 1). Re-read and retry.");
    await waitFor(() => expect((within(d).getByRole("textbox", { name: "Title" }) as HTMLTextAreaElement).value).toBe("Changed meanwhile"));
    expect(within(d).getByText("v2")).toBeTruthy();
    expect(server.sent("PATCH /api/app/tickets/AA-2")).toHaveLength(1); // not retried over the top
  });

  test("a description edit that started on an older version warns while it is open, and a refused save keeps the draft", async () => {
    markdownMode();
    const { d, state } = await open((s) => s.on("PATCH /api/app/tickets/AA-2", () => apiError(409, "conflict", "AA-2 was changed (version 2, you had 1). Re-read and retry.", { current: T2 })));
    const user = userEvent.setup();
    await user.click(within(d).getByRole("button", { name: "Add a description…" }));
    await waitFor(() => expect(descriptionBox(d)).toBeTruthy());
    await user.type(descriptionBox(d), "my draft");
    state.ticket = { ...state.ticket, version: 2, title: "Someone else edited" };
    act(() => FakeEventSource.open[0]?.emit("change", { seq: 4 }));
    expect((await within(d).findByRole("status")).textContent).toMatch(/This ticket changed while you were editing \(now v2\)/);
    await user.click(within(d).getByRole("button", { name: "Save" }));
    expect((await within(d).findByRole("alert")).textContent).toMatch(/was changed \(version 2, you had 1\)/);
    expect(descriptionBox(d).value).toBe("my draft"); // still editing, nothing lost
  });

  test("saving a description sends the version it was started from", async () => {
    markdownMode();
    const { server, d } = await open((s) => s.on("PATCH /api/app/tickets/AA-2", { ticket: { ...T2, body: "hello", version: 2 } }));
    const user = userEvent.setup();
    await user.click(within(d).getByRole("button", { name: "Add a description…" }));
    await waitFor(() => expect(descriptionBox(d)).toBeTruthy());
    await user.type(descriptionBox(d), "hello");
    await user.click(within(d).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(server.sent("PATCH /api/app/tickets/AA-2")).toHaveLength(1));
    expect(server.sent("PATCH /api/app/tickets/AA-2")[0].body).toEqual({ body: "hello", version: 1 });
    await waitFor(() => expect(within(d).queryByRole("button", { name: "Save" })).toBeNull()); // left edit mode
  });
});

describe("comments", () => {
  test("typing and pressing Comment sends it, clears the box and reads the ticket again", async () => {
    const { server, d, state } = await open((s) =>
      s.on("POST /api/app/tickets/AA-2/comments", () => Response.json({ comment: { id: "c9", authorKind: "human", authorName: "Ada", body: "Hi", createdAt: new Date().toISOString() } }, { status: 201 })),
    );
    const user = userEvent.setup();
    const button = within(d).getByRole("button", { name: /^Comment/ }) as HTMLButtonElement;
    expect(button.disabled).toBe(true); // nothing to send yet
    await user.type(within(d).getByRole("textbox", { name: "Comment" }), "Hi **there**");
    state.comments = [{ id: "c9", authorKind: "human", authorName: "Ada Lovelace", body: "Hi **there**", createdAt: new Date().toISOString() }];
    await user.click(button);
    await waitFor(() => expect(server.sent("POST /api/app/tickets/AA-2/comments")).toHaveLength(1));
    expect(server.sent("POST /api/app/tickets/AA-2/comments")[0].body).toEqual({ body: "Hi **there**" });
    expect((within(d).getByRole("textbox", { name: "Comment" }) as HTMLTextAreaElement).value).toBe("");
    await within(d).findByText("there"); // rendered as Markdown in the thread
  });

  test("Cmd or Ctrl+Enter sends it too", async () => {
    const { server, d } = await open((s) => s.on("POST /api/app/tickets/AA-2/comments", { comment: {} }));
    const user = userEvent.setup();
    await user.type(within(d).getByRole("textbox", { name: "Comment" }), "Quick{Control>}{Enter}{/Control}");
    await waitFor(() => expect(server.sent("POST /api/app/tickets/AA-2/comments")).toHaveLength(1));
  });

  test("a long thread shows the latest four with 'show earlier'", async () => {
    const many = Array.from({ length: 7 }, (_, i) => ({ id: `c${i}`, authorKind: "human" as const, authorName: "Ada", body: `message ${i}`, createdAt: new Date().toISOString() }));
    const { d } = await open((s) => s.on("GET /api/app/tickets/AA-2", detail(T2, { comments: many })));
    expect(within(d).queryByText("message 0")).toBeNull();
    expect(within(d).getByText("message 6")).toBeTruthy();
    await userEvent.setup().click(within(d).getByRole("button", { name: /Show 3 earlier messages/ }));
    expect(within(d).getByText("message 0")).toBeTruthy();
  });
});

describe("the properties", () => {
  const pick = async (user: ReturnType<typeof userEvent.setup>, d: HTMLElement, field: string, option: string) => {
    const field_ = within(d).getByText(field, { selector: "span.label" }).parentElement as HTMLElement;
    await user.click(within(field_).getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: option }));
  };

  test("Status moves the ticket by column id (not by name), and the board reads again", async () => {
    const { server, d } = await open((s) => s.on("POST /api/app/tickets/AA-2/move", { ticket: T2 }));
    await pick(userEvent.setup(), d, "Status", "Review");
    await waitFor(() => expect(server.sent("POST /api/app/tickets/AA-2/move")).toHaveLength(1));
    expect(server.sent("POST /api/app/tickets/AA-2/move")[0].body).toEqual({ column: "c-review" });
    await waitFor(() => expect(server.sent("GET /api/app/projects/AA/board").length).toBeGreaterThan(1));
  });

  test("Priority and Assignee are saved with the version", async () => {
    const { server, d } = await open((s) => s.on("PATCH /api/app/tickets/AA-2", { ticket: T2 }));
    const user = userEvent.setup();
    await pick(user, d, "Priority", "urgent");
    await waitFor(() => expect(server.sent("PATCH /api/app/tickets/AA-2")).toHaveLength(1));
    expect(server.sent("PATCH /api/app/tickets/AA-2")[0].body).toEqual({ priority: "urgent", version: 1 });
    await pick(user, d, "Assignee", "Grace Hopper");
    await waitFor(() => expect(server.sent("PATCH /api/app/tickets/AA-2")).toHaveLength(2));
    expect(server.sent("PATCH /api/app/tickets/AA-2")[1].body).toEqual({ assigneeId: "u2", version: 1 });
  });

  test("Unassigned clears the assignee with null", async () => {
    const { server, d } = await open((s) => {
      serve(s, { assigneeId: "u1" });
      s.on("PATCH /api/app/tickets/AA-2", { ticket: T2 });
    });
    await pick(userEvent.setup(), d, "Assignee", "Unassigned");
    await waitFor(() => expect(server.sent("PATCH /api/app/tickets/AA-2")).toHaveLength(1));
    expect(server.sent("PATCH /api/app/tickets/AA-2")[0].body).toEqual({ assigneeId: null, version: 1 });
  });

  test("the AI switch lets agents pick the ticket up, or not", async () => {
    const { server, d } = await open((s) => s.on("PATCH /api/app/tickets/AA-2", { ticket: T2 }));
    await userEvent.setup().click(within(d).getByRole("checkbox"));
    await waitFor(() => expect(server.sent("PATCH /api/app/tickets/AA-2")).toHaveLength(1));
    expect(server.sent("PATCH /api/app/tickets/AA-2")[0].body).toEqual({ agentClaimable: false, version: 1 });
  });

  test("labels: adding one with Enter is saved after a moment, as a list, against the latest version", async () => {
    const { server, d } = await open((s) => s.on("PATCH /api/app/tickets/AA-2", { ticket: T2 }));
    const user = userEvent.setup();
    await user.type(within(d).getByRole("textbox", { name: "Add a label" }), "frontend{Enter}");
    await waitFor(() => expect(server.sent("PATCH /api/app/tickets/AA-2")).toHaveLength(1), { timeout: 3000 });
    expect(server.sent("PATCH /api/app/tickets/AA-2")[0].body).toEqual({ labels: ["frontend"], version: 1 });
  });

  test("a refused property change says why, and the ticket on screen is the real one", async () => {
    const { d } = await open((s) => s.on("PATCH /api/app/tickets/AA-2", apiError(400, "invalid", "Assignee must be a member of your workspace", { fields: { assigneeId: "x" } })));
    await pick(userEvent.setup(), d, "Assignee", "Grace Hopper");
    expect((await within(d).findByRole("alert")).textContent).toBe("Assignee must be a member of your workspace");
  });
});

describe("the architecture links", () => {
  test("linked nodes show, link to the map, and can be unlinked; another can be linked", async () => {
    const { server, d } = await open((s) => {
      const state = serve(s);
      state.nodes = [{ id: "n-api", name: "API", kind: "service", parentId: null }];
      s.on("DELETE /api/app/tickets/AA-2/nodes/n-api", { ok: true });
      s.on("PUT /api/app/tickets/AA-2/nodes/n-board", { ok: true });
    });
    const user = userEvent.setup();
    const link = within(d).getByRole("link", { name: "system: API" });
    expect(link.getAttribute("href")).toBe("/p/AA/map?node=n-api");
    await user.click(within(d).getByRole("button", { name: "Unlink API" }));
    await waitFor(() => expect(server.sent("DELETE /api/app/tickets/AA-2/nodes/n-api")).toHaveLength(1));
    await user.click((within(d).getByText("+ link node").closest("button") ?? within(d).getByText("+ link node")) as HTMLElement);
    await user.click(await screen.findByRole("option", { name: "system: API › Board UI" }));
    await waitFor(() => expect(server.sent("PUT /api/app/tickets/AA-2/nodes/n-board")).toHaveLength(1));
  });
});

describe("deleting", () => {
  test("asks first; Delete removes it, closes the dialog and reads the board again; Cancel does nothing", async () => {
    const { server, d, router } = await open((s) => s.on("DELETE /api/app/tickets/AA-2", { ok: true }));
    const user = userEvent.setup();
    await user.click(within(d).getByRole("button", { name: "Delete ticket" }));
    const ask = await screen.findByRole("alertdialog");
    expect(within(ask).getByText("Delete AA-2?")).toBeTruthy();
    await user.click(within(ask).getByRole("button", { name: "Cancel" }));
    expect(server.sent("DELETE /api/app/tickets/AA-2")).toHaveLength(0);
    await user.click(within(d).getByRole("button", { name: "Delete ticket" }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(server.sent("DELETE /api/app/tickets/AA-2")).toHaveLength(1));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(router.state.location.search).toBe("");
  });
});

describe("moving between tickets, and the keyboard", () => {
  test("the header shows the place in the column and steps with the buttons", async () => {
    const { d, router } = await open();
    expect(within(d).getByText("1 / 2")).toBeTruthy();
    expect((within(d).getByRole("button", { name: "Previous ticket in this column" }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.setup().click(within(d).getByRole("button", { name: "Next ticket in this column" }));
    await waitFor(() => expect(router.state.location.search).toBe("?t=AA-3"));
    await waitFor(() => expect(screen.getByText("2 / 2")).toBeTruthy());
  });

  test("the arrow keys step through the column", async () => {
    const { router } = await open();
    const user = userEvent.setup();
    await user.keyboard("{ArrowRight}");
    await waitFor(() => expect(router.state.location.search).toBe("?t=AA-3"));
    await user.keyboard("{ArrowLeft}");
    await waitFor(() => expect(router.state.location.search).toBe("?t=AA-2"));
  });

  test("but not while typing in a field, where they move the cursor", async () => {
    const { d, router } = await open();
    const user = userEvent.setup();
    await user.type(within(d).getByRole("textbox", { name: "Comment" }), "abc{ArrowLeft}{ArrowLeft}");
    expect(router.state.location.search).toBe("?t=AA-2");
  });

  test("with unsaved text, closing or stepping asks before throwing it away; Cancel keeps it, Discard goes ahead", async () => {
    const { d, router } = await open();
    const user = userEvent.setup();
    await user.type(within(d).getByRole("textbox", { name: "Comment" }), "half a thought");
    await user.click(screen.getByRole("button", { name: "Close ticket" }));
    const ask = await screen.findByRole("alertdialog");
    expect(within(ask).getByText("Discard unsaved changes?")).toBeTruthy();
    await user.click(within(ask).getByRole("button", { name: "Cancel" }));
    expect((within(d).getByRole("textbox", { name: "Comment" }) as HTMLTextAreaElement).value).toBe("half a thought");
    expect(router.state.location.search).toBe("?t=AA-2");
    await user.click(screen.getByRole("button", { name: "Next ticket in this column" }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(router.state.location.search).toBe("?t=AA-3"));
  });

  test("Escape with unsaved text asks too, rather than losing it", async () => {
    const { d } = await open();
    const user = userEvent.setup();
    await user.type(within(d).getByRole("textbox", { name: "Comment" }), "keep me");
    await user.keyboard("{Escape}");
    expect(await screen.findByRole("alertdialog")).toBeTruthy();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  test("focus lands on the dialog itself, not on a field (no surprise keyboard on a phone)", async () => {
    const { d } = await open();
    await waitFor(() => expect(document.activeElement).toBe(d));
  });
});

describe("live updates while it is open", () => {
  test("a comment by an agent appears without a refresh, and the title you are not editing follows the server", async () => {
    const { d, state } = await open();
    await waitFor(() => expect(FakeEventSource.open.length).toBe(1));
    state.comments = [{ id: "c1", authorKind: "agent", authorName: "CI bot", body: "Tests are green", createdAt: new Date().toISOString() }];
    state.ticket = { ...state.ticket, title: "Renamed by an agent", version: 2 };
    act(() => FakeEventSource.open[0].emit("change", { seq: 5 }));
    await within(d).findByText("Tests are green");
    await waitFor(() => expect((within(d).getByRole("textbox", { name: "Title" }) as HTMLTextAreaElement).value).toBe("Renamed by an agent"));
  });

  test("but a title being typed is not overwritten", async () => {
    const { d, state } = await open();
    const user = userEvent.setup();
    const title = within(d).getByRole("textbox", { name: "Title" }) as HTMLTextAreaElement;
    await user.click(title);
    await user.type(title, " (draft)");
    state.ticket = { ...state.ticket, title: "Renamed by an agent", version: 2 };
    act(() => FakeEventSource.open[0].emit("change", { seq: 6 }));
    await within(d).findByText("v2");
    expect(title.value).toBe("Build the board (draft)");
  });
});
