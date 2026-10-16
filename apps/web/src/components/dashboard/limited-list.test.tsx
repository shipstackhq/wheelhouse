import { test } from "vitest";
import assert from "node:assert/strict";
import { renderToStaticMarkup as render } from "react-dom/server";
import { StaticRouter } from "react-router";
import { LimitedSection, SECTION_LIMIT, TwoLineRow } from "./limited-list";
import { CollapsibleList } from "../collapsible-list";

/** These rows contain router links, which need a router around them even to render to a string. */
const renderToStaticMarkup = (el: React.ReactElement) => render(<StaticRouter location="/">{el}</StaticRouter>);

const visible = (html: string) => html.replace(/<[^>]+>/g, "|").replace(/\|+/g, "|").replace(/&#x27;/g, "'");
const row = (n: number) => <TwoLineRow key={n} lead={`R${n}`} title={`title ${n}`} meta={`meta ${n}`} tip={<b>tip {n}</b>} />;
const items = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

test("a section shows its title with the total count and at most three rows", () => {
  const html = renderToStaticMarkup(<LimitedSection title="Agent went quiet" items={items(7)} row={row} />);
  const text = visible(html);
  assert.equal(SECTION_LIMIT, 3);
  assert.match(text, /Agent went quiet\s*\|\(7\)/, "the count is the total, not the shown rows");
  assert.ok(!html.includes("uppercase") && !html.includes("tracking-wide") && !html.includes('class="label"'), "heading is sentence case, not caps");
  for (const n of [1, 2, 3]) assert.ok(text.includes(`title ${n}`));
  for (const n of [4, 5, 6, 7]) assert.ok(!text.includes(`title ${n}`), `row ${n} is behind +N more`);
  assert.ok(text.includes("+4 more"));
});

test("the rest sit behind a '+N more' button; nothing extra is rendered until it is pressed", () => {
  const html = renderToStaticMarkup(<LimitedSection title="t" items={items(5)} row={row} />);
  assert.ok(html.includes("+2 more") && html.includes('aria-expanded="false"'));
  assert.ok(!html.includes("title 4") && !html.includes("title 5"));
  assert.ok(!html.includes("aria-haspopup"), "no popover");
  assert.ok(!html.includes("overflow-y-auto"), "collapsed, the list is not a scroller");
});

test("expanded, the whole list is one bounded, scrollable list and 'show less' is pinned at the end of it", () => {
  const html = renderToStaticMarkup(
    <CollapsibleList limit={3} title="Agent went quiet" defaultOpen>
      {items(5).map(row)}
    </CollapsibleList>,
  );
  const ul = html.match(/<ul[^>]*>/)![0];
  assert.match(ul, /max-h-56/);
  assert.match(ul, /overflow-y-auto/);
  assert.ok(ul.includes('aria-label="Agent went quiet, all 5"'));
  const text = visible(html);
  for (const n of items(5)) assert.ok(text.includes(`title ${n}`), `row ${n} is in the scroller (not just the extra ones)`);
  assert.ok(!text.includes("more"), "no '+N more' once open");
  const footer = html.slice(html.lastIndexOf("<li"));
  assert.ok(footer.includes("sticky bottom-0") && footer.includes("show less"), "last item of the scroller, sticky to its bottom");
  assert.ok(html.includes('aria-expanded="true"'));
});

test("three or fewer rows: no '+N more' and no scroller; none at all: nothing is rendered", () => {
  const html = renderToStaticMarkup(<LimitedSection title="t" items={items(3)} row={row} />);
  assert.ok(!visible(html).includes("more") && !html.includes("overflow-y-auto") && !html.includes("<button"));
  assert.equal(renderToStaticMarkup(<LimitedSection title="t" items={[]} row={row} />), "");
});

test("a row is two lines: lead and title, then the muted who/when; long text is left to the tooltip", () => {
  const html = renderToStaticMarkup(<TwoLineRow lead="WH-12" title="A long ticket title" meta="🤖 Laptop · 3h ago" tip={<span>full details</span>} />);
  assert.equal(visible(html), "|WH-12|A long ticket title|🤖 Laptop · 3h ago|");
  assert.ok(html.includes("truncate"), "text truncates instead of wrapping or overflowing");
  assert.ok(html.includes('tabindex="0"'), "a non-link row is focusable so keyboard users can reach the tooltip");
  assert.ok(!html.includes("full details"), "tooltip content stays out of the page until hovered or focused");
});

test("a row with a destination is a link", () => {
  const html = renderToStaticMarkup(<TwoLineRow href="/p/WH?t=WH-12" lead="WH-12" title="x" meta="y" tip="z" />);
  assert.match(html, /<a [^>]*href="\/p\/WH\?t=WH-12"/);
});

test("the lists on the dashboard are striped lists: compact rows that run edge to edge of the card", () => {
  const html = renderToStaticMarkup(<LimitedSection title="t" items={items(2)} row={row} />);
  assert.ok(html.includes('class="list text-sm"') && html.includes('data-density="compact"') && html.includes('data-inset="card"'));
});

test("the row's hover/focus area grows back over the list padding so it covers the whole striped row", () => {
  const html = renderToStaticMarkup(<TwoLineRow href="/x" lead="a" title="b" meta="c" tip="d" />);
  assert.ok(html.includes("-mx-[var(--list-px)]") && html.includes("px-[var(--list-px)]") && html.includes("py-[var(--list-py)]"));
});

test("a row without a lead (map drafts) is still two lines, starting at the left", () => {
  const html = renderToStaticMarkup(<TwoLineRow title="system:Service layer" meta="update · Laptop · 3h ago" tip="x" />);
  assert.equal(visible(html), "|system:Service layer|update · Laptop · 3h ago|");
  assert.ok(!html.includes("grid-cols"), "no empty lead column");
  assert.ok(!html.includes("✎"));
});
