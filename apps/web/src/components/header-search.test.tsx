import { describe, expect, test } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { SearchHit, SearchKind } from "@wheelhouse/api-client";
import { HeaderSearch, metaLine } from "./header-search";
import { highlight, mockProvider, type SearchProvider } from "../lib/search";
import { renderIn } from "../test/harness";

const hit = (kind: SearchKind, n: number, extra: Partial<SearchHit> = {}): SearchHit => ({
  kind,
  id: `${kind}${n}`,
  projectKey: "AA",
  title: `${kind} number ${n} about memory`,
  snippet: "a snippet about memory",
  marks: [[`${kind} number ${n} about `.length, `${kind} number ${n} about memory`.length]],
  meta: kind === "ticket" ? { ref: `AA-${n}`, column: "Todo", priority: "high" } : kind === "decision" ? { number: n, status: "accepted" } : {},
  href: `/p/AA/${kind}/${n}`,
  score: 1 - n / 100 - KINDS_ORDER.indexOf(kind) / 1000,
  ...extra,
});
const KINDS_ORDER = ["ticket", "doc", "node", "decision", "term"];
const COUNTS: Record<SearchKind, number> = { ticket: 7, doc: 2, node: 1, decision: 1, term: 1 };

/** A provider that answers every kind at once, can fail some kinds, and records what it was asked. */
function fake(opts: { fail?: SearchKind[]; counts?: Partial<Record<SearchKind, number>>; hold?: SearchKind[] } = {}) {
  const asked: { kind: SearchKind; query: string; scope: string }[] = [];
  const failing = new Set(opts.fail ?? []);
  const provider: SearchProvider = async (kind, query, scope) => {
    asked.push({ kind, query, scope });
    if (opts.hold?.includes(kind)) return new Promise(() => {});
    if (failing.has(kind)) throw new Error("boom");
    const n = opts.counts?.[kind] ?? COUNTS[kind];
    const hits = Array.from({ length: n }, (_, i) => hit(kind, i + 1));
    return { kind, total: n, hits };
  };
  return { provider, asked, failing };
}

const setup = (provider: SearchProvider, extra: { onCreateTicket?: (t: string) => void | Promise<void> } = {}) => {
  const view = renderIn(<HeaderSearch projectKey="AA" provider={provider} {...extra} />, "/p/AA");
  const box = () => screen.getByRole("combobox");
  return { ...view, box };
};
/** Every kind has answered: no skeletons left, and there are rows. */
const loaded = () =>
  waitFor(() => {
    expect(screen.queryAllByTestId(/^skeleton-/)).toHaveLength(0);
    expect(screen.getAllByRole("option").length).toBeGreaterThan(0);
  });
const type = async (text: string) => {
  const u = userEvent.setup();
  await u.click(screen.getByRole("combobox"));
  await u.type(screen.getByRole("combobox"), text);
  return u;
};

describe("opening and closing", () => {
  test("focusing the bar opens the panel with recent searches and a try line, and asks nothing", async () => {
    localStorage.setItem("wh_search_recent", JSON.stringify(["memory", "WH-87"]));
    const { provider, asked } = fake();
    setup(provider);
    expect(screen.queryByRole("listbox")).toBeNull();
    await userEvent.setup().click(screen.getByRole("combobox"));
    expect(await screen.findByRole("listbox")).toBeTruthy();
    expect(screen.getByRole("combobox").getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Recent searches")).toBeTruthy();
    expect(screen.getByRole("button", { name: /memory/ })).toBeTruthy();
    expect(screen.getByText(/Try/)).toBeTruthy();
    expect(asked).toHaveLength(0);
  });

  test("clearing recent searches empties the list and the stored copy", async () => {
    localStorage.setItem("wh_search_recent", JSON.stringify(["memory"]));
    setup(fake().provider);
    const u = userEvent.setup();
    await u.click(screen.getByRole("combobox"));
    await u.click(await screen.findByRole("button", { name: "Clear" }));
    expect(screen.queryByText("Recent searches")).toBeNull();
    expect(localStorage.getItem("wh_search_recent")).toBe("[]");
  });

  test("Esc once clears the text, twice closes the panel and returns focus to the input", async () => {
    setup(fake().provider);
    const u = await type("mem");
    await screen.findAllByRole("option");
    await u.keyboard("{Escape}");
    expect((screen.getByRole("combobox") as HTMLInputElement).value).toBe("");
    expect(screen.getByRole("listbox")).toBeTruthy();
    await u.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole("combobox"));
  });

  test("clicking outside closes it", async () => {
    setup(fake().provider);
    await type("mem");
    await screen.findAllByRole("option");
    fireEvent.pointerDown(document.body);
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
  });

  test("going to another page closes it", async () => {
    const { router } = setup(fake().provider);
    await type("mem");
    await screen.findAllByRole("option");
    await act(async () => void (await router.navigate("/p/AA/overview")));
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
  });

  test("blurring an empty box closes it", async () => {
    setup(fake().provider);
    const u = userEvent.setup();
    await u.click(screen.getByRole("combobox"));
    await screen.findByRole("listbox");
    await u.tab();
    await u.tab({ shift: true });
    document.body.focus();
    fireEvent.blur(screen.getByRole("combobox"), { relatedTarget: null });
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
  });

  test("/ and ⌘/ open and focus the search, but / types normally inside a text field", async () => {
    const { container } = renderIn(
      <>
        <HeaderSearch projectKey="AA" provider={fake().provider} />
        <textarea aria-label="other" />
      </>,
      "/p/AA",
    );
    expect(container).toBeTruthy();
    const u = userEvent.setup();
    await u.click(screen.getByLabelText("other"));
    await u.keyboard("/");
    expect((screen.getByLabelText("other") as HTMLTextAreaElement).value).toBe("/");
    expect(screen.queryByRole("listbox")).toBeNull();
    (document.activeElement as HTMLElement).blur();
    await u.keyboard("/");
    expect(await screen.findByRole("listbox")).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("combobox")));
    document.body.focus();
    fireEvent.pointerDown(document.body);
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
    await u.click(screen.getByLabelText("other"));
    await u.keyboard("{Meta>}/{/Meta}");
    expect(await screen.findByRole("listbox")).toBeTruthy();
  });
});

describe("results", () => {
  test("show best matches then a section per kind, with counts, highlights, meta lines and a combobox wired to its options", async () => {
    setup(fake().provider);
    await type("memory");
    await screen.findByRole("group", { name: "Best matches" });
    const best = screen.getByRole("group", { name: "Best matches" });
    expect(within(best).getAllByRole("option")).toHaveLength(5);
    for (const name of ["Tickets", "Docs", "Map", "Decisions", "Glossary"]) expect(screen.getByRole("group", { name })).toBeTruthy();
    const tickets = screen.getByRole("group", { name: "Tickets" });
    expect(within(tickets).getAllByRole("option")).toHaveLength(5); // previewed
    expect(within(tickets).getByText("Show all 7")).toBeTruthy();
    expect(within(tickets).getAllByText("memory", { selector: "mark" }).length).toBeGreaterThan(0);
    expect(screen.getAllByText("AA-1 · Todo · high").length).toBeGreaterThan(0);
    expect(screen.getAllByText("ADR-1 · accepted").length).toBeGreaterThan(0);
    const box = screen.getByRole("combobox");
    const active = box.getAttribute("aria-activedescendant")!;
    expect(document.getElementById(active)?.getAttribute("role")).toBe("option");
    expect(box.getAttribute("aria-controls")).toBe(screen.getByRole("listbox").id);
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("12 results"));
  });

  test("Show all expands one section", async () => {
    setup(fake().provider);
    const u = await type("memory");
    await u.click(await screen.findByText("Show all 7"));
    expect(within(screen.getByRole("group", { name: "Tickets" })).getAllByRole("option")).toHaveLength(7);
  });

  test("the project shows on a row only when searching all projects", async () => {
    setup(fake().provider);
    const u = await type("memory");
    await screen.findByRole("group", { name: "Tickets" });
    expect(screen.queryByText("AA · AA-1 · Todo · high")).toBeNull();
    await u.click(screen.getByRole("button", { name: "All my projects" }));
    expect((await screen.findAllByText("AA · AA-1 · Todo · high")).length).toBeGreaterThan(0);
  });

  test("a query of one letter does not search; a ref does", async () => {
    const f = fake();
    setup(f.provider);
    const u = await type("m");
    await new Promise((r) => setTimeout(r, 250));
    expect(f.asked).toHaveLength(0);
    await u.clear(screen.getByRole("combobox"));
    await u.type(screen.getByRole("combobox"), "WH-87");
    await waitFor(() => expect(f.asked.length).toBe(5));
  });

  test("typing fast sends one round of requests, for the last text", async () => {
    const f = fake();
    setup(f.provider);
    await type("memory");
    await screen.findAllByRole("option");
    expect(new Set(f.asked.map((a) => a.query))).toEqual(new Set(["memory"]));
  });
});

describe("keyboard", () => {
  test("arrows move through rows across sections, wrap, and Home/End jump", async () => {
    setup(fake({ counts: { ticket: 1, doc: 1, node: 1, decision: 1, term: 1 } }).provider);
    const u = await type("memory");
    await loaded();
    const box = screen.getByRole("combobox");
    const ids = () => screen.getAllByRole("option").map((o) => o.id);
    const current = () => ids().indexOf(box.getAttribute("aria-activedescendant")!);
    expect(current()).toBe(0);
    await u.keyboard("{ArrowDown}{ArrowDown}");
    expect(current()).toBe(2);
    await u.keyboard("{End}");
    expect(current()).toBe(ids().length - 1);
    expect(screen.getAllByRole("option")[ids().length - 1].getAttribute("aria-selected")).toBe("true");
    await u.keyboard("{ArrowDown}");
    expect(current()).toBe(0);
    await u.keyboard("{ArrowUp}");
    expect(current()).toBe(ids().length - 1);
    await u.keyboard("{Home}");
    expect(current()).toBe(0);
  });

  test("Enter opens the active result and closes the panel; ⌘Enter opens a new tab and keeps it", async () => {
    const { router } = setup(fake().provider);
    const u = await type("memory");
    await screen.findAllByRole("option");
    await u.keyboard("{ArrowDown}{Enter}");
    await waitFor(() => expect(router.state.location.pathname).toBe("/p/AA/doc/1"));
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
    expect(JSON.parse(localStorage.getItem("wh_search_recent")!)).toEqual(["memory"]);
    expect(JSON.parse(localStorage.getItem("wh_search_opened")!)[0].href).toBe("/p/AA/doc/1");
  });

  test("⌘Enter opens in a new tab", async () => {
    const opened: unknown[][] = [];
    const real = window.open;
    window.open = ((...a: unknown[]) => (opened.push(a), null)) as typeof window.open;
    try {
      setup(fake().provider);
      const u = await type("memory");
      await screen.findAllByRole("option");
      await u.keyboard("{Meta>}{Enter}{/Meta}");
      expect(opened[0]?.[0]).toBe("/p/AA/ticket/1");
      expect(screen.getByRole("listbox")).toBeTruthy();
    } finally {
      window.open = real;
    }
  });
});

describe("filters", () => {
  test("chips carry live counts, filter to one kind (showing all of it), and ← → switch chips", async () => {
    setup(fake().provider);
    const u = await type("memory");
    await loaded();
    const toolbar = screen.getByRole("toolbar", { name: "Filter results" });
    await waitFor(() => expect(within(toolbar).getByRole("button", { name: /^All\s*12$/ })).toBeTruthy());
    const tickets = within(toolbar).getByRole("button", { name: /^Tickets\s*7$/ });
    await u.click(tickets);
    expect(tickets.getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByRole("group", { name: "Best matches" })).toBeNull();
    expect(screen.queryByRole("group", { name: "Docs" })).toBeNull();
    expect(within(screen.getByRole("group", { name: "Tickets" })).getAllByRole("option")).toHaveLength(7);
    tickets.focus();
    await u.keyboard("{ArrowRight}");
    await waitFor(() => expect(within(toolbar).getByRole("button", { name: /^Docs/ }).getAttribute("aria-pressed")).toBe("true"));
    expect(document.activeElement).toBe(within(toolbar).getByRole("button", { name: /^Docs/ }));
    await u.keyboard("{ArrowLeft}{ArrowLeft}");
    expect(within(toolbar).getByRole("button", { name: /^All\s*\d*$/ }).getAttribute("aria-pressed")).toBe("true");
  });

  test("Tab from the input reaches the chips", async () => {
    setup(fake().provider);
    const u = await type("memory");
    await loaded();
    await u.tab();
    expect(document.activeElement?.closest("[role=toolbar]")).toBeTruthy();
  });
});

describe("loading, failing and empty", () => {
  test("each kind fills in on its own: a held kind shows a skeleton while the others show results", async () => {
    setup(fake({ hold: ["doc"] }).provider);
    await type("memory");
    await waitFor(() => expect(within(screen.getByRole("group", { name: "Tickets" })).getAllByRole("option").length).toBeGreaterThan(0));
    await waitFor(() => expect(within(screen.getByRole("group", { name: "Map" })).getAllByRole("option").length).toBe(1));
    expect(screen.getByTestId("skeleton-doc")).toBeTruthy();
    expect(within(screen.getByRole("group", { name: "Map" })).getAllByRole("option").length).toBe(1);
  });

  test("a failed kind shows an inline retry and does not block the others; Retry asks again and recovers", async () => {
    const f = fake({ fail: ["doc"] });
    setup(f.provider);
    const u = await type("memory");
    const docs = await screen.findByRole("group", { name: "Docs" });
    expect(await within(docs).findByText(/Couldn't load docs/)).toBeTruthy();
    expect(within(screen.getByRole("group", { name: "Tickets" })).getAllByRole("option").length).toBeGreaterThan(0);
    expect(screen.getByRole("group", { name: "Glossary" })).toBeTruthy();
    f.failing.clear();
    const before = f.asked.length;
    await u.click(within(docs).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(within(screen.getByRole("group", { name: "Docs" })).getAllByRole("option")).toHaveLength(2));
    expect(f.asked.slice(before).map((a) => a.kind)).toEqual(["doc"]);
  });

  test("no results says so, echoes the query and suggests widening; create-a-ticket shows only when allowed", async () => {
    const counts = { ticket: 0, doc: 0, node: 0, decision: 0, term: 0 };
    const created: string[] = [];
    const { unmount } = setup(fake({ counts }).provider);
    await type("zzzz");
    expect(await screen.findByText("No results for “zzzz”")).toBeTruthy();
    expect(screen.getByText(/Try All my projects/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Create a ticket/ })).toBeNull();
    unmount();
    setup(fake({ counts }).provider, { onCreateTicket: (t) => void created.push(t) });
    const u = await type("zzzz");
    await u.click(await screen.findByRole("button", { name: "Create a ticket titled “zzzz”" }));
    expect(created).toEqual(["zzzz"]);
  });

  test("creating a ticket waits for the ticket to be made, then closes the panel", async () => {
    const counts = { ticket: 0, doc: 0, node: 0, decision: 0, term: 0 };
    let finish: () => void = () => {};
    const made: string[] = [];
    setup(fake({ counts }).provider, {
      onCreateTicket: (t) => {
        made.push(t);
        return new Promise<void>((resolve) => (finish = resolve));
      },
    });
    const u = await type("zzzz");
    await u.click(await screen.findByRole("button", { name: "Create a ticket titled “zzzz”" }));
    const busy = await screen.findByRole("button", { name: "Creating…" });
    expect((busy as HTMLButtonElement).disabled).toBe(true);
    await u.click(busy); // a second click while it is being made does nothing
    expect(made).toEqual(["zzzz"]);
    finish();
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
    expect(screen.queryByText(/Couldn't create the ticket/)).toBeNull();
  });

  test("a ticket that could not be created says so, keeps the panel and the query, and can be tried again", async () => {
    const counts = { ticket: 0, doc: 0, node: 0, decision: 0, term: 0 };
    let attempts = 0;
    setup(fake({ counts }).provider, {
      onCreateTicket: async () => {
        if (++attempts === 1) throw new Error("offline");
      },
    });
    const u = await type("zzzz");
    await u.click(await screen.findByRole("button", { name: "Create a ticket titled “zzzz”" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Couldn't create the ticket/);
    expect((screen.getByRole("combobox") as HTMLInputElement).value).toBe("zzzz");
    await u.click(screen.getByRole("button", { name: "Create a ticket titled “zzzz”" }));
    await waitFor(() => expect(attempts).toBe(2));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  test("while a new query loads the previous results stay on screen, dimmed", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    const provider: SearchProvider = async (kind) => {
      if (++calls > 5) await gate;
      return { kind, total: 1, hits: [hit(kind, 1)] };
    };
    setup(provider);
    const u = await type("memory");
    await screen.findByRole("group", { name: "Tickets" });
    await u.type(screen.getByRole("combobox"), "s");
    await waitFor(() => expect(document.querySelector("[aria-busy=true]")).toBeTruthy());
    expect(screen.getByRole("group", { name: "Tickets" })).toBeTruthy();
    expect(document.querySelector("[aria-busy=true]")!.className).toContain("opacity-60");
    release();
    await waitFor(() => expect(document.querySelector("[aria-busy=false]")).toBeTruthy());
  });

  test("offline shows a note", async () => {
    setup(fake().provider);
    await type("memory");
    await screen.findAllByRole("option");
    act(() => void window.dispatchEvent(new Event("offline")));
    expect(await screen.findByText(/You are offline/)).toBeTruthy();
  });
});

describe("the mock provider and helpers", () => {
  test("the mock provider answers per kind and honours the dev switches", async () => {
    const ctl = new AbortController();
    const ok = await mockProvider("ticket", "memory", "project", "AA", ctl.signal);
    expect(ok.hits.length).toBeGreaterThan(0);
    localStorage.setItem("wh_search_mock", "empty");
    expect((await mockProvider("ticket", "memory", "project", "AA", ctl.signal)).total).toBe(0);
    localStorage.setItem("wh_search_mock", "error:doc");
    await expect(mockProvider("doc", "memory", "project", "AA", ctl.signal)).rejects.toThrow();
    await expect(mockProvider("ticket", "memory", "project", "AA", ctl.signal)).resolves.toBeTruthy();
  });

  test("highlight splits text on ranges and tolerates overlap and out-of-range", () => {
    expect(highlight("hello world", [[0, 5]])).toEqual([{ text: "hello", mark: true }, { text: " world", mark: false }]);
    expect(highlight("abcdef", [[1, 3], [2, 5], [9, 12]]).filter((r) => r.mark).map((r) => r.text)).toEqual(["bc", "de"]);
    expect(highlight("plain")).toEqual([{ text: "plain", mark: false }]);
  });

  test("meta lines per kind", () => {
    expect(metaLine(hit("doc", 1, { meta: { path: "ops/runbook", updatedAt: "2026-10-12" } }), false)).toBe("ops/runbook · updated 2026-10-12");
    expect(metaLine(hit("node", 1, { meta: { layer: "system", kind: "service" } }), true)).toBe("AA · system · service");
    expect(metaLine(hit("term", 1, { meta: { term: "Agent" } }), false)).toBe("Glossary · Agent");
  });
});
