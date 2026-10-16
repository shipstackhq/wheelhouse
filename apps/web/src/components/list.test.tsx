import { test } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { List } from "./list";

const css = fs.readFileSync(path.join(process.cwd(), "src/app.css"), "utf8");

test("a list is a ul of rows with the shared class; normal density, no inset by default", () => {
  const html = renderToStaticMarkup(
    <List>
      <li>one</li>
      <li>two</li>
    </List>,
  );
  assert.match(html, /^<ul [^>]*class="list"/);
  assert.ok(html.includes('data-density="normal"') && html.includes('data-inset="none"'));
  assert.ok(html.includes("<li>one</li><li>two</li>"));
});

test("density and inset are passed through as data attributes, and extra classes and props are kept", () => {
  const html = renderToStaticMarkup(
    <List density="compact" inset="card" className="max-h-56 text-sm" id="x" aria-label="Rows">
      <li>a</li>
    </List>,
  );
  assert.ok(html.includes('data-density="compact"') && html.includes('data-inset="card"'));
  assert.match(html, /class="list max-h-56 text-sm"/);
  assert.ok(html.includes('id="x"') && html.includes('aria-label="Rows"'));
  assert.ok(renderToStaticMarkup(<List density="roomy" inset="flush"><li>a</li></List>).includes('data-density="roomy"'));
});

test("it can be an ordered list", () => {
  assert.match(renderToStaticMarkup(<List ordered><li>a</li></List>), /^<ol /);
});

test("the stylesheet gives every density a padding, stripes the even rows and can skip a row", () => {
  for (const d of ["compact", "roomy"]) assert.match(css, new RegExp(`\\.list\\[data-density="${d}"\\]\\s*\\{[^}]*--list-py`), `${d} sets its padding`);
  assert.match(css, /\.list\s*\{[^}]*--list-py[^}]*--list-px/, "normal is the base");
  assert.match(css, /\.list > li\s*\{[^}]*padding:\s*var\(--list-py\) var\(--list-px\)/);
  assert.match(css, /\.list > li:nth-child\(even\):not\(\[data-plain\]\)\s*\{[^}]*background/);
  assert.match(css, /\.list\[data-inset="card"\]\s*\{[^}]*margin-inline:\s*-1rem/, "card lists cancel the card padding");
  assert.ok(css.indexOf('[data-inset="card"]') > css.indexOf('[data-density="roomy"]'), "inset wins over density for the side padding");
});

test("nothing uses the old zebra classes any more: every striped list goes through List", () => {
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, f.name);
      if (f.isDirectory()) walk(p);
      else if (/\.(tsx?|css)$/.test(f.name) && !f.name.includes(".test.") && /zebra/.test(fs.readFileSync(p, "utf8"))) offenders.push(p);
    }
  };
  walk(path.join(process.cwd(), "src"));
  assert.deepEqual(offenders, []);
});
