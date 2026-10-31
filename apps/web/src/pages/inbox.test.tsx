import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { apiError, renderApp, type FakeServer } from "../test/harness";
import { FakeEventSource } from "../test/fake-event-source";
import { plainSnippet, type InboxItem, type InboxView } from "../lib/notifications";

beforeEach(() => FakeEventSource.reset());
afterEach(() => vi.useRealTimers());

const DAY = 24 * 60 * 60 * 1000;
const EARLIER = "2026-10-20T00:00:00.000Z";
/** A trashed item, purged at `purgeAt`. */
const trashed = (n: number, purgeAt: string, over: Partial<InboxItem> = {}) => item(n, { deletedAt: EARLIER, purgeAt, ...over });

const item = (n: number, over: Partial<InboxItem> = {}): InboxItem => ({
  id: `n${n}`,
  teamId: "id-AA",
  type: "issue.assigned",
  source: "issues",
  title: `Item ${n}`,
  body: `Body ${n}`,
  bodyFormat: "text",
  href: `/t/AA?t=AA-${n}`,
  actor: { kind: "human", name: "Grace" },
  subject: { entity: "issue", id: `i${n}` },
  readAt: null,
  createdAt: new Date(Date.now() - n * 60_000).toISOString(),
  archivedAt: null,
  deletedAt: null,
  purgeAt: null,
  ...over,
});

/**
 * An inbox that changes: the fake answers the lists (by `view`), the count, the marks and the moves between views from its records, as the
 * real one would. An item is in the inbox unless it is archived or deleted; deleting keeps the archive flag, so restoring puts it back.
 */
function inbox(server: FakeServer, items: InboxItem[], pageSize = 25) {
  const records = new Map(items.map((n) => [n.id, { ...n }]));
  const inView: Record<InboxView, (n: InboxItem) => boolean> = {
    inbox: (n) => !n.archivedAt && !n.deletedAt,
    archived: (n) => !!n.archivedAt && !n.deletedAt,
    trash: (n) => !!n.deletedAt,
  };
  const change = (id: string, patch: Partial<InboxItem>) => {
    const next = { ...records.get(id)!, ...patch };
    records.set(id, next);
    return { notification: next };
  };
  server.on("GET /api/app/notifications", (seen) => {
    const q = new URL(seen.url, "http://x").searchParams;
    const view = (q.get("view") ?? "inbox") as InboxView;
    const rows = [...records.values()].filter((n) => inView[view](n) && (q.get("unreadOnly") ? !n.readAt : true));
    const from = Number(q.get("cursor") ?? 0);
    const page = rows.slice(from, from + Math.min(pageSize, Number(q.get("limit") ?? 25)));
    return { items: page, nextCursor: from + page.length < rows.length ? String(from + page.length) : null };
  });
  server.on("GET /api/app/notifications/unread-count", () => ({ count: [...records.values()].filter((n) => inView.inbox(n) && !n.readAt).length }));
  server.on("POST /api/app/notifications/read-all", () => {
    let updated = 0;
    for (const n of records.values()) {
      if (!inView.inbox(n) || n.readAt) continue;
      updated++;
      records.set(n.id, { ...n, readAt: new Date().toISOString() });
    }
    return { updated };
  });
  for (const i of items) {
    const at = `/api/app/notifications/${i.id}`;
    server.on(`POST ${at}/read`, () => change(i.id, { readAt: new Date().toISOString() }));
    server.on(`POST ${at}/archive`, () => change(i.id, { archivedAt: new Date().toISOString() }));
    server.on(`POST ${at}/unarchive`, () => change(i.id, { archivedAt: null }));
    server.on(`DELETE ${at}`, () => {
      const now = new Date();
      return change(i.id, { deletedAt: now.toISOString(), purgeAt: new Date(now.getTime() + 30 * DAY).toISOString() });
    });
    server.on(`POST ${at}/restore`, () => change(i.id, { deletedAt: null, purgeAt: null }));
  }
  return records;
}
/** The list row for a title (the reader on the right may show the same title, outside any li). */
const row = async (title: string) => (await screen.findAllByText(title)).map((e) => e.closest("li")).find(Boolean) as HTMLElement;
const nav = () => screen.getByRole("navigation", { name: "Main" });
const pickView = async (user: ReturnType<typeof userEvent.setup>, name: string) => {
  await user.click(screen.getByRole("button", { name: /^Filter:/ }));
  await user.click(screen.getByRole("button", { name }));
};

describe("the inbox page", () => {
  test("lists newest first and sets unread rows apart from read ones", async () => {
    renderApp("/inbox", (s) => inbox(s, [item(1), item(2, { readAt: "2026-10-20T00:00:00.000Z" })]));
    expect((await row("Item 1")).dataset.unread).toBe("true");
    expect((await row("Item 2")).dataset.unread).toBeUndefined();
    const titles = screen.getAllByRole("listitem").map((li) => li.textContent);
    expect(titles[0]).toContain("Item 1");
    expect(titles[1]).toContain("Item 2");
  });

  test("selecting a row opens it on the right, marks it read, keeps the page and puts it in the URL", async () => {
    const { server, router, at } = renderApp("/inbox", (s) => inbox(s, [item(1), item(2)]));
    await userEvent.setup().click(await screen.findByRole("button", { name: /^Item 1/ }));
    await waitFor(() => expect(server.sent("POST /api/app/notifications/n1/read")).toHaveLength(1));
    const reader = await screen.findByRole("article");
    expect(within(reader).getByRole("heading", { name: "Item 1" })).toBeTruthy();
    expect(within(reader).getByText("Body 1")).toBeTruthy();
    expect(within(reader).getByText(/About: issue/)).toBeTruthy();
    expect(at()).toBe("/inbox");
    expect(router.state.location.search).toBe("?n=n1");
    expect(within(reader).getByRole("link", { name: "Open issue" }).getAttribute("href")).toBe("/w/ae/t/AA?t=AA-1");
    await waitFor(async () => expect((await row("Item 1")).dataset.unread).toBeUndefined());
  });

  test("an agent's question is answered from the inbox: the reply is a comment on the issue and the item is archived", async () => {
    const { server } = renderApp("/inbox?n=n1", (s) => {
      inbox(s, [item(1, { type: "run.question", title: "Remy has a question on AA-1", body: "which database?" })]);
      s.on("POST /api/app/issues/AA-1/comments", { comment: { id: "c1", authorKind: "human", authorName: "Ada", body: "Postgres", createdAt: EARLIER } });
    });
    const reader = await screen.findByRole("article");
    const user = userEvent.setup();
    await user.type(within(reader).getByRole("textbox", { name: "Your answer" }), "Postgres");
    await user.click(within(reader).getByRole("button", { name: "Reply" }));
    await waitFor(() => expect(server.sent("POST /api/app/issues/AA-1/comments")).toHaveLength(1));
    expect(server.sent("POST /api/app/issues/AA-1/comments")[0].body).toEqual({ body: "Postgres" });
    await waitFor(() => expect(server.sent("POST /api/app/notifications/n1/archive")).toHaveLength(1));
  });

  test("a selection in the URL opens on load; an id that is not in the list shows the empty state", async () => {
    renderApp("/inbox?n=n2", (s) => inbox(s, [item(1), item(2)]));
    expect(await screen.findByRole("heading", { name: "Item 2" })).toBeTruthy();
  });

  test("nothing selected, or an unknown id, says Select a notification", async () => {
    renderApp("/inbox?n=gone", (s) => inbox(s, [item(1)]));
    await screen.findAllByText("Item 1");
    expect(screen.getByText("Select a notification")).toBeTruthy();
    expect(screen.queryByRole("article")).toBeNull();
  });

  test("Back (narrow screens) clears the selection", async () => {
    const { router } = renderApp("/inbox?n=n1", (s) => inbox(s, [item(1)]));
    await userEvent.setup().click(await screen.findByRole("button", { name: "Back" }));
    await waitFor(() => expect(router.state.location.search).toBe(""));
    expect(await screen.findByText("Select a notification")).toBeTruthy();
  });

  test("Arrow Down moves the selection to the next row", async () => {
    const { router } = renderApp("/inbox?n=n1", (s) => inbox(s, [item(1), item(2)]));
    const user = userEvent.setup();
    (await screen.findByRole("button", { name: /^Item 1/ })).focus();
    await user.keyboard("{ArrowDown}");
    await waitFor(() => expect(router.state.location.search).toBe("?n=n2"));
  });

  test("mark all read marks everything and is off when nothing is unread", async () => {
    const { server } = renderApp("/inbox", (s) => inbox(s, [item(1), item(2)]));
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Mark all read" }));
    await waitFor(() => expect(server.sent("POST /api/app/notifications/read-all")).toHaveLength(1));
    await waitFor(() => expect((screen.getByRole("button", { name: "Mark all read" }) as HTMLButtonElement).disabled).toBe(true));
    expect((await row("Item 1")).dataset.unread).toBeUndefined();
  });

  test("archiving the open notification from the reader clears the selection", async () => {
    const { server, router } = renderApp("/inbox?n=n1", (s) => inbox(s, [item(1), item(2)]));
    await userEvent.setup().click(await screen.findByRole("button", { name: "Archive" }));
    await waitFor(() => expect(server.sent("POST /api/app/notifications/n1/archive")).toHaveLength(1));
    await waitFor(() => expect(screen.queryByText("Item 1")).toBeNull());
    expect(router.state.location.search).toBe("");
    expect(screen.getByText("Select a notification")).toBeTruthy();
  });

  test("archiving takes the row out", async () => {
    const { server } = renderApp("/inbox", (s) => inbox(s, [item(1), item(2)]));
    await userEvent.setup().click(await screen.findByRole("button", { name: "Archive: Item 1" }));
    await waitFor(() => expect(screen.queryByText("Item 1")).toBeNull());
    expect(server.sent("POST /api/app/notifications/n1/archive")).toHaveLength(1);
    expect(screen.getByText("Item 2")).toBeTruthy();
  });

  test("the Unread switch asks for unreadOnly, and switching it off shows everything", async () => {
    const { server } = renderApp("/inbox", (s) => inbox(s, [item(1), item(2, { readAt: "2026-10-20T00:00:00.000Z" })]));
    const user = userEvent.setup();
    await row("Item 2");
    await user.click(screen.getByRole("button", { name: "Unread only" }));
    await waitFor(() => expect(screen.queryByText("Item 2")).toBeNull());
    expect(server.calls.some((c) => c.url.startsWith("/api/app/notifications?") && c.url.includes("unreadOnly=true"))).toBe(true);
    await user.click(screen.getByRole("button", { name: "Unread only" }));
    await row("Item 2");
  });

  test("Load more follows the cursor and goes away on the last page", async () => {
    const { server } = renderApp("/inbox", (s) => inbox(s, [item(1), item(2), item(3)], 2));
    const user = userEvent.setup();
    await screen.findByText("Item 2");
    expect(screen.queryByText("Item 3")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Load more" }));
    await screen.findByText("Item 3");
    expect(server.calls.some((c) => c.url.includes("cursor=2"))).toBe(true);
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });

  test("with nothing it says all caught up", async () => {
    renderApp("/inbox", (s) => inbox(s, []));
    await screen.findByText("All caught up");
  });

  test("a failed read says so and Try again reads it again", async () => {
    const { server } = renderApp("/inbox", (s) => s.on("GET /api/app/notifications", () => apiError(400, "boom", "No inbox for you")));
    await screen.findByText("No inbox for you");
    const before = server.sent("GET /api/app/notifications").length;
    await userEvent.setup().click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(server.sent("GET /api/app/notifications").length).toBeGreaterThan(before));
  });

  test("the sidebar's Inbox link shows the unread count and shows none at zero", async () => {
    renderApp("/inbox", (s) => inbox(s, [item(1), item(2)]));
    const link = await screen.findByRole("link", { name: /Inbox/ });
    await waitFor(() => expect(link.textContent).toContain("2"));
    expect(link.getAttribute("href")).toBe("/w/ae/inbox");
    await userEvent.setup().click(await screen.findByRole("button", { name: "Mark all read" }));
    await waitFor(() => expect(within(nav()).getByRole("link", { name: "Inbox" }).textContent).toBe("Inbox"));
  });

  test("the list and the reader are split by a separator with the width bounds", async () => {
    renderApp("/inbox", (s) => inbox(s, [item(1)]));
    await screen.findAllByText("Item 1");
    const sep = screen.getByRole("separator", { name: "Resize the notification list" });
    expect(sep.getAttribute("aria-orientation")).toBe("vertical");
    expect(sep.getAttribute("aria-valuenow")).toBe("384");
    expect(sep.getAttribute("aria-valuemin")).toBe("300");
    expect(sep.getAttribute("aria-valuemax")).toBe("560");
  });

  test("ArrowRight and ArrowLeft move the divider by 16px", async () => {
    renderApp("/inbox", (s) => inbox(s, [item(1)]));
    const user = userEvent.setup();
    const sep = await screen.findByRole("separator");
    sep.focus();
    await user.keyboard("{ArrowRight}");
    expect(sep.getAttribute("aria-valuenow")).toBe("400");
    await user.keyboard("{ArrowLeft}{ArrowLeft}");
    expect(sep.getAttribute("aria-valuenow")).toBe("368");
  });

  test("the width clamps at the min and the max", async () => {
    renderApp("/inbox", (s) => inbox(s, [item(1)]));
    const user = userEvent.setup();
    const sep = await screen.findByRole("separator");
    sep.focus();
    for (let i = 0; i < 20; i++) await user.keyboard("{ArrowRight}");
    expect(sep.getAttribute("aria-valuenow")).toBe("560");
    for (let i = 0; i < 30; i++) await user.keyboard("{ArrowLeft}");
    expect(sep.getAttribute("aria-valuenow")).toBe("300");
    expect(sep.previousElementSibling).toBeTruthy();
    expect((sep.previousElementSibling as HTMLElement).style.getPropertyValue("--inbox-list-w")).toBe("300px");
  });

  test("a stored width is restored, and an out-of-range one is clamped", async () => {
    localStorage.setItem("wh:inbox:list-width", "444");
    const { unmount } = renderApp("/inbox", (s) => inbox(s, [item(1)]));
    await screen.findAllByText("Item 1");
    expect(screen.getByRole("separator").getAttribute("aria-valuenow")).toBe("444");
    unmount();
    localStorage.setItem("wh:inbox:list-width", "9999");
    renderApp("/inbox", (s) => inbox(s, [item(1)]));
    await screen.findAllByText("Item 1");
    expect(screen.getByRole("separator").getAttribute("aria-valuenow")).toBe("560");
  });

  test("a changed width is kept in localStorage", async () => {
    renderApp("/inbox", (s) => inbox(s, [item(1)]));
    const user = userEvent.setup();
    const sep = await screen.findByRole("separator");
    sep.focus();
    await user.keyboard("{ArrowRight}");
    expect(localStorage.getItem("wh:inbox:list-width")).toBe("400");
  });

  test("a storage that throws neither breaks the page nor the divider", async () => {
    const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    try {
      renderApp("/inbox", (s) => inbox(s, [item(1)]));
      await screen.findAllByText("Item 1");
      const sep = screen.getByRole("separator");
      expect(sep.getAttribute("aria-valuenow")).toBe("384");
      sep.focus();
      await userEvent.setup().keyboard("{ArrowRight}");
      expect(sep.getAttribute("aria-valuenow")).toBe("400");
    } finally {
      get.mockRestore();
      set.mockRestore();
    }
  });

  test("the Unread switch, Mark all read and the filter share one height", async () => {
    renderApp("/inbox", (s) => inbox(s, [item(1)]));
    await screen.findAllByText("Item 1");
    const toggle = screen.getByRole("button", { name: "Unread only" });
    const markAll = screen.getByRole("button", { name: "Mark all read" });
    const filter = screen.getByRole("button", { name: "Filter: Inbox" });
    expect(toggle.className).toContain("h-6");
    expect(toggle.className).toContain("rounded-full");
    expect(markAll.className).toContain("h-6");
    expect(filter.className).toContain("h-6");
  });

  test("the live signal reads the inbox again", async () => {
    const { server } = renderApp("/inbox", (s) => inbox(s, [item(1)]));
    await screen.findByText("Item 1");
    const lists = () => server.sent("GET /api/app/notifications").length;
    const before = lists();
    const stream = FakeEventSource.open.find((s) => s.url.startsWith("/api/stream"))!;
    stream.emit("change", { type: "inbox.changed" });
    await waitFor(() => expect(lists()).toBeGreaterThan(before));
    expect(server.sent("GET /api/app/notifications/unread-count").length).toBeGreaterThan(1);
  });
});

describe("the header bell", () => {
  test("shows the latest items, opens one in the inbox reader, and the dot follows the unread count", async () => {
    const { server, router } = renderApp("/", (s) => inbox(s, [item(1), item(2, { readAt: "2026-10-20T00:00:00.000Z" })]));
    const user = userEvent.setup();
    const bell = await screen.findByRole("button", { name: "Notifications, 1 unread" });
    expect(screen.getByTestId("bell-dot")).toBeTruthy();
    await user.click(bell);
    await user.click(await screen.findByRole("button", { name: /^Item 1/ }));
    await waitFor(() => expect(server.sent("POST /api/app/notifications/n1/read")).toHaveLength(1));
    await waitFor(() => expect(router.state.location.pathname + router.state.location.search).toBe("/w/ae/inbox?n=n1"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Notifications" })).toBeTruthy());
    expect(screen.queryByTestId("bell-dot")).toBeNull();
  });

  test("mark all read and View all work from the tray", async () => {
    const { server, at } = renderApp("/", (s) => inbox(s, [item(1)]));
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Notifications, 1 unread" }));
    await user.click(await screen.findByRole("button", { name: "Mark all read" }));
    await waitFor(() => expect(server.sent("POST /api/app/notifications/read-all")).toHaveLength(1));
    await user.click(screen.getByRole("link", { name: "View all" }));
    await waitFor(() => expect(at()).toBe("/inbox"));
  });
});

describe("the inbox views", () => {
  test("the view switcher asks for the view, puts it in the URL, and Inbox drops it", async () => {
    const { server, router } = renderApp("/inbox", (s) => inbox(s, [item(1)]));
    const user = userEvent.setup();
    await row("Item 1");
    await pickView(user, "Archived");
    await waitFor(() => expect(router.state.location.search).toBe("?view=archived"));
    await waitFor(() => expect(server.calls.some((c) => c.url.startsWith("/api/app/notifications?") && c.url.includes("view=archived"))).toBe(true));
    await pickView(user, "Trash");
    await waitFor(() => expect(router.state.location.search).toBe("?view=trash"));
    await waitFor(() => expect(server.calls.some((c) => c.url.includes("view=trash"))).toBe(true));
    await pickView(user, "Inbox");
    await waitFor(() => expect(router.state.location.search).toBe(""));
    expect(await screen.findByRole("button", { name: "Filter: Inbox" })).toBeTruthy();
  });

  test("switching view clears the selection", async () => {
    const { router } = renderApp("/inbox?n=n1", (s) => inbox(s, [item(1)]));
    await screen.findByRole("article");
    await pickView(userEvent.setup(), "Archived");
    await waitFor(() => expect(router.state.location.search).toBe("?view=archived"));
    expect(await screen.findByText("Select a notification")).toBeTruthy();
  });

  test("the All / Unread toggle and Mark all read are only in the inbox", async () => {
    renderApp("/inbox", (s) => inbox(s, [item(1)]));
    const user = userEvent.setup();
    await row("Item 1");
    expect(screen.getByRole("button", { name: "Unread only" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Mark all read" })).toBeTruthy();
    await pickView(user, "Archived");
    await screen.findByText("No archived notifications");
    expect(screen.queryByRole("button", { name: "Unread only" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Mark all read" })).toBeNull();
    await pickView(user, "Trash");
    await screen.findByText("Trash is empty");
    expect(screen.queryByRole("button", { name: "Unread only" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Mark all read" })).toBeNull();
    await pickView(user, "Inbox");
    expect(await screen.findByRole("button", { name: "Unread only" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Mark all read" })).toBeTruthy();
  });

  test("the inbox row and reader offer Archive and Delete, and no Restore", async () => {
    renderApp("/inbox?n=n1", (s) => inbox(s, [item(1), item(2)]));
    const r = await row("Item 1");
    expect(within(r).getByRole("button", { name: "Archive: Item 1" })).toBeTruthy();
    expect(within(r).getByRole("button", { name: "Delete: Item 1" })).toBeTruthy();
    const reader = await screen.findByRole("article");
    expect(within(reader).getByRole("button", { name: "Archive" })).toBeTruthy();
    expect(within(reader).getByRole("button", { name: "Delete" })).toBeTruthy();
    expect(within(reader).queryByRole("button", { name: "Restore" })).toBeNull();
  });

  test("Delete in the inbox sends DELETE, takes the row out, and clears a selection on it", async () => {
    const { server, router } = renderApp("/inbox?n=n1", (s) => inbox(s, [item(1), item(2)]));
    await userEvent.setup().click(await screen.findByRole("button", { name: "Delete: Item 1" }));
    await waitFor(() => expect(server.sent("DELETE /api/app/notifications/n1")).toHaveLength(1));
    await waitFor(() => expect(screen.queryByText("Item 1")).toBeNull());
    expect(screen.getByText("Item 2")).toBeTruthy();
    expect(router.state.location.search).toBe("");
    expect(screen.getByText("Select a notification")).toBeTruthy();
  });

  test("Archive from the reader sends archive and clears; the row offers Unarchive and Delete in Archived", async () => {
    const { server } = renderApp("/inbox?view=archived", (s) => inbox(s, [item(1, { archivedAt: EARLIER }), item(2)]));
    const user = userEvent.setup();
    const r = await row("Item 1");
    expect(screen.queryByText("Item 2")).toBeNull();
    expect(within(r).getByRole("button", { name: "Unarchive: Item 1" })).toBeTruthy();
    expect(within(r).getByRole("button", { name: "Delete: Item 1" })).toBeTruthy();
    expect(within(r).queryByRole("button", { name: "Archive: Item 1" })).toBeNull();
    await user.click(within(r).getByRole("button", { name: "Unarchive: Item 1" }));
    await waitFor(() => expect(server.sent("POST /api/app/notifications/n1/unarchive")).toHaveLength(1));
    await waitFor(() => expect(screen.queryByText("Item 1")).toBeNull());
    expect(screen.getByText("No archived notifications")).toBeTruthy();
  });

  test("the reader's Unarchive in Archived clears the selection and keeps the view", async () => {
    const { server, router } = renderApp("/inbox?view=archived&n=n1", (s) => inbox(s, [item(1, { archivedAt: EARLIER })]));
    const user = userEvent.setup();
    const reader = await screen.findByRole("article");
    expect(within(reader).getByRole("button", { name: "Unarchive" })).toBeTruthy();
    expect(within(reader).queryByRole("button", { name: "Archive" })).toBeNull();
    await user.click(within(reader).getByRole("button", { name: "Unarchive" }));
    await waitFor(() => expect(server.sent("POST /api/app/notifications/n1/unarchive")).toHaveLength(1));
    await waitFor(() => expect(router.state.location.search).toBe("?view=archived"));
    expect(screen.getByText("Select a notification")).toBeTruthy();
  });

  test("Trash offers only Restore, with Open issue kept; Restore puts the item back and clears the selection", async () => {
    const { server, router } = renderApp("/w/ae/inbox?view=trash&n=n1", (s) => inbox(s, [trashed(1, "2026-11-10T00:00:00.000Z", { href: "/w/ae/t/AA?t=AA-1" }), item(2)]));
    const user = userEvent.setup();
    const reader = await screen.findByRole("article");
    expect(within(reader).getByRole("button", { name: "Restore" })).toBeTruthy();
    expect(within(reader).getByRole("link", { name: "Open issue" })).toBeTruthy();
    expect(within(reader).queryByRole("button", { name: "Delete" })).toBeNull();
    expect(within(reader).queryByRole("button", { name: "Archive" })).toBeNull();
    await user.click(within(reader).getByRole("button", { name: "Restore" }));
    await waitFor(() => expect(server.sent("POST /api/app/notifications/n1/restore")).toHaveLength(1));
    await waitFor(() => expect(router.state.location.search).toBe("?view=trash"));
    await screen.findByText("Trash is empty");
    expect(screen.getByText("Select a notification")).toBeTruthy();
  });

  test("the trash row offers Restore on hover, and no Delete", async () => {
    const { server } = renderApp("/inbox?view=trash", (s) => inbox(s, [trashed(1, "2026-11-10T00:00:00.000Z")]));
    const user = userEvent.setup();
    const r = await row("Item 1");
    expect(within(r).queryByRole("button", { name: "Delete: Item 1" })).toBeNull();
    await user.click(within(r).getByRole("button", { name: "Restore: Item 1" }));
    await waitFor(() => expect(server.sent("POST /api/app/notifications/n1/restore")).toHaveLength(1));
    await screen.findByText("Trash is empty");
  });

  test("trash says how many days are left, from purgeAt, in the row and the reader", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-24T12:00:00.000Z"));
    const now = Date.now();
    const at = (days: number) => new Date(now + days * DAY).toISOString();
    renderApp("/inbox?view=trash&n=n1", (s) => inbox(s, [trashed(1, at(4.5)), trashed(2, at(0.5)), trashed(3, at(-1 / 24))]));
    const reader = await screen.findByRole("article");
    expect(within(reader).getByText("Deleted · removed in 5 days")).toBeTruthy();
    expect(within(await row("Item 1")).getByText("Deleted · removed in 5 days")).toBeTruthy();
    expect(within(await row("Item 2")).getByText("Deleted · removed in 1 day")).toBeTruthy();
    expect(within(await row("Item 3")).getByText("Deleted · removed today")).toBeTruthy();
  });

  test("picking a trashed item does not mark it read", async () => {
    const { server } = renderApp("/inbox?view=trash", (s) => inbox(s, [trashed(1, "2026-11-10T00:00:00.000Z")]));
    await userEvent.setup().click(await screen.findByRole("button", { name: /^Item 1/ }));
    await screen.findByRole("article");
    expect(server.sent("POST /api/app/notifications/n1/read")).toHaveLength(0);
  });

  test("the empty states say what each view holds", async () => {
    const { router } = renderApp("/inbox", (s) => inbox(s, []));
    const user = userEvent.setup();
    await screen.findByText("All caught up");
    await pickView(user, "Archived");
    await screen.findByText("No archived notifications");
    await pickView(user, "Trash");
    await screen.findByText("Trash is empty");
    expect(screen.getByText("Deleted notifications are removed after 30 days.")).toBeTruthy();
    expect(router.state.location.search).toBe("?view=trash");
  });

  test("a failed read in Archived or Trash says so and Try again reads it again", async () => {
    const { server } = renderApp("/inbox?view=trash", (s) => s.on("GET /api/app/notifications", () => apiError(400, "boom", "No trash for you")));
    await screen.findByText("No trash for you");
    const before = server.sent("GET /api/app/notifications").length;
    await userEvent.setup().click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(server.sent("GET /api/app/notifications").length).toBeGreaterThan(before));
  });

  test("a view in the URL is restored on load, with its switcher pressed and its own list", async () => {
    const { server } = renderApp("/inbox?view=archived", (s) => inbox(s, [item(1, { archivedAt: EARLIER }), item(2)]));
    expect(await screen.findByRole("button", { name: "Filter: Archived" })).toBeTruthy();
    await row("Item 1");
    expect(screen.queryByText("Item 2")).toBeNull();
    expect(server.calls.some((c) => c.url.includes("view=archived"))).toBe(true);
  });
});


describe("markdown bodies", () => {
  const md = "Looked at **this** and `fix()`:\n\n- one\n- two\n\nSee [the docs](https://example.com/x).";

  test("a markdown body is rendered in the reader and shown as plain words in the row", async () => {
    const { router } = renderApp("/inbox?n=n1", (s) => inbox(s, [item(1, { body: md, bodyFormat: "markdown" })]));
    const reader = await screen.findByRole("article");
    expect(within(reader).getByText("this").tagName).toBe("STRONG");
    expect(within(reader).getByText("fix()").tagName).toBe("CODE");
    expect(within(reader).getAllByRole("listitem")).toHaveLength(2);
    const link = within(reader).getByRole("link", { name: "the docs" });
    expect(link.getAttribute("href")).toBe("https://example.com/x");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noreferrer");
    const list = await row("Item 1");
    expect(list.textContent).toContain("Looked at this and fix(): one two See the docs.");
    expect(list.textContent).not.toContain("**");
    expect(router.state.location.search).toBe("?n=n1");
  });

  test("a plain-text body stays literal, even when it looks like markdown", async () => {
    renderApp("/inbox?n=n1", (s) => inbox(s, [item(1, { body: "fix *the* _thing_\nsecond line", bodyFormat: "text" })]));
    const reader = await screen.findByRole("article");
    expect(within(reader).getByText(/fix \*the\* _thing_/)).toBeTruthy();
    expect(reader.querySelector("em, strong")).toBeNull();
  });

  test("raw HTML and script links in a markdown body do nothing", async () => {
    renderApp("/inbox?n=n1", (s) => inbox(s, [item(1, { body: '<img src=x onerror="alert(1)"><script>window.__x=1</script>[go](javascript:alert(1))', bodyFormat: "markdown" })]));
    const reader = await screen.findByRole("article");
    expect(reader.querySelector("img, script")).toBeNull();
    expect((window as unknown as { __x?: number }).__x).toBeUndefined();
    const go = within(reader).queryByRole("link", { name: "go" });
    expect(go?.getAttribute("href") ?? "").not.toMatch(/^javascript:/i);
  });
});

describe("plainSnippet", () => {
  test("drops the syntax and keeps the words, on one line", () => {
    expect(plainSnippet("# Title\n> quoted *text*\n1. first\n- [link](http://a.b) and ![img](x.png)")).toBe("Title quoted text first link and img");
    expect(plainSnippet("```ts\nconst a = 1;\n```\nafter")).toBe("const a = 1; after");
    expect(plainSnippet("  plain   words \n here ")).toBe("plain words here");
  });
});
