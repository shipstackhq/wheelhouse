import { test } from "vitest";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { HistoryList, type HistoryItem } from "./history-list";

const visible = (html: string) => html.replace(/<[^>]+>/g, "|").replace(/\|+/g, "|").replace(/&#x27;/g, "'");
const now = Date.now();
const ev = (seq: number, name: string, summary: string, minAgo: number, kind: "human" | "agent" = "human"): HistoryItem => ({ seq, actorKind: kind, actorName: name, summary, createdAt: new Date(now - minAgo * 60e3) });
const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

test("the same doer is named once for a run of changes, not on every line", () => {
  const html = renderToStaticMarkup(
    <HistoryList items={[ev(5, "Claude Atharva's Macbook Pro", "moved WH-48 from In Progress → Review", 1, "agent"), ev(4, "Claude Atharva's Macbook Pro", "commented on WH-48", 1, "agent"), ev(3, "Claude Atharva's Macbook Pro", "linked WH-48 to \"Board UI\"", 2, "agent"), ev(2, "Demo", "updated WH-48: priority", 30)]} />,
  );
  const text = visible(html);
  assert.equal(count(text, "Claude Atharva's Macbook Pro"), 1, "the agent's name appears once");
  assert.equal(count(text, "Demo"), 1);
  assert.ok(text.includes("3 changes"));
  for (const s of ["moved WH-48 from In Progress → Review", "commented on WH-48", "updated WH-48: priority"]) assert.ok(text.includes(s), s);
});

test("agents are marked, a single change has no count, and the time is shown", () => {
  const text = visible(renderToStaticMarkup(<HistoryList items={[ev(2, "Bot", "created WH-1", 2, "agent"), ev(1, "Demo", "moved WH-1", 5000)]} />));
  assert.ok(text.includes("🤖 Bot"));
  assert.ok(!text.includes("1 changes") && !text.includes("change|"), "no count for a single change");
  assert.ok(text.includes("just now") || text.includes("2m ago"));
});

test("a different doer in between breaks the run, so nobody's changes are merged with someone else's", () => {
  const text = visible(renderToStaticMarkup(<HistoryList items={[ev(3, "Demo", "a", 1), ev(2, "Bot", "b", 2, "agent"), ev(1, "Demo", "c", 3)]} />));
  assert.equal(count(text, "Demo"), 2);
});

test("only the latest ten changes show at first, with a way to see the rest; no history says so", () => {
  const many = Array.from({ length: 14 }, (_, i) => ev(100 - i, "Demo", `change ${i}`, i + 1));
  const text = visible(renderToStaticMarkup(<HistoryList items={many} />));
  assert.ok(text.includes("change 9") && !text.includes("change 10"));
  assert.ok(text.includes("Show 4 more"));
  assert.ok(visible(renderToStaticMarkup(<HistoryList items={[]} />)).includes("No history yet."));
});

test("showing more scrolls the list in place, in a plain wrapper with no background, border or padding", () => {
  const many = Array.from({ length: 14 }, (_, i) => ev(100 - i, "Demo", `change ${i}`, i + 1));
  const html = renderToStaticMarkup(<HistoryList items={many} defaultExpanded />);
  const text = visible(html);
  assert.ok(text.includes("change 13") && text.includes("Show less"), "everything is there, with a way back");
  const wrapper = html.match(/<div class="([^"]*overflow-y-auto[^"]*)"/)![1];
  assert.match(wrapper, /max-h-64/, "still bounded in height");
  for (const pattern of [/\bbg-/, /\bborder/, /\bp[xytblr]?-\d/, /\brounded/]) assert.ok(!pattern.test(wrapper), `no ${pattern} (got: ${wrapper})`);
});

test("the count beside a doer is that doer's real total, also while only the latest ten lines are showing", () => {
  const run = Array.from({ length: 14 }, (_, i) => ev(100 - i, "Claude", `change ${i}`, i + 1, "agent"));
  for (const defaultExpanded of [false, true]) {
    const text = visible(renderToStaticMarkup(<HistoryList items={run} defaultExpanded={defaultExpanded} />));
    assert.ok(text.includes("14 changes"), `expanded=${defaultExpanded}: the count is 14`);
    assert.ok(!text.includes("10 changes"), "never the size of the preview");
  }
  const collapsed = visible(renderToStaticMarkup(<HistoryList items={run} />));
  assert.ok(collapsed.includes("change 9") && !collapsed.includes("change 10"), "still only ten lines until you ask for more");
  assert.ok(collapsed.includes("Show 4 more"));
});

test("when the ten-line preview ends inside a run, that run still shows its full count, and later runs stay hidden", () => {
  const items = [
    ...Array.from({ length: 4 }, (_, i) => ev(50 - i, "Demo", `d${i}`, i + 1)),
    ...Array.from({ length: 9 }, (_, i) => ev(40 - i, "Bot", `b${i}`, 10 + i, "agent")),
    ev(1, "Sam", "s0", 600),
  ];
  const text = visible(renderToStaticMarkup(<HistoryList items={items} />));
  assert.ok(text.includes("4 changes"), "Demo: all four lines");
  assert.ok(text.includes("9 changes"), "Bot: header says 9 though only six of its lines fit in the preview");
  assert.ok(text.includes("b5") && !text.includes("b6"), "ten lines in total: four + six");
  assert.ok(!text.includes("Sam"), "the run after the preview is not shown yet");
  assert.ok(text.includes("Show 4 more"));
});

test("a run split by someone else counts separately, and a lone change shows no count", () => {
  const text = visible(renderToStaticMarkup(<HistoryList items={[ev(3, "Demo", "a", 1), ev(2, "Bot", "b", 2, "agent"), ev(1, "Demo", "c", 3)]} />));
  assert.ok(!/\d+ changes/.test(text));
});
