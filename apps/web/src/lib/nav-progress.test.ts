import { test } from "vitest";
import assert from "node:assert/strict";
import { nextProgress, PROGRESS_CEILING, PROGRESS_START, startsNavigation } from "./nav-progress";

const here = "https://wheelhouse.shipstack.run/p/WH";
const click = (href: string, over: Record<string, unknown> = {}) => ({
  button: 0,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  defaultPrevented: false,
  anchor: { href, target: "", hasDownload: false },
  ...over,
});

test("the bar moves forward on every tick, slows down, and never reaches the end by itself", () => {
  let p = PROGRESS_START;
  let last = 0;
  for (let i = 0; i < 200; i++) {
    const n = nextProgress(p);
    assert.ok(n >= p, "never goes backwards");
    assert.ok(n <= PROGRESS_CEILING, "stops at the ceiling until the page actually arrives");
    last = n - p;
    p = n;
  }
  assert.ok(last < 0.01, "the steps shrink to almost nothing");
  assert.ok(nextProgress(PROGRESS_START) - PROGRESS_START > nextProgress(80) - 80, "faster at the start than near the ceiling");
});

test("a plain click on a link to another page of the app starts the bar", () => {
  assert.equal(startsNavigation(click("https://wheelhouse.shipstack.run/p/WH/map"), here), true);
  assert.equal(startsNavigation(click("https://wheelhouse.shipstack.run/workspace"), here), true);
});

test("changing only the query counts, because opening a ticket is a navigation", () => {
  assert.equal(startsNavigation(click("https://wheelhouse.shipstack.run/p/WH?t=WH-12"), here), true);
});

test("clicks that do not navigate in this tab do not start it", () => {
  assert.equal(startsNavigation(click(here), here), false, "same page, same query");
  assert.equal(startsNavigation(click(`${here}#top`), here), false, "only a hash differs");
  assert.equal(startsNavigation(click("https://example.com/x"), here), false, "another site");
  assert.equal(startsNavigation(click("https://wheelhouse.shipstack.run/workspace", { anchor: { href: "https://wheelhouse.shipstack.run/workspace", target: "_blank", hasDownload: false } }), here), false, "new tab");
  assert.equal(startsNavigation(click("https://wheelhouse.shipstack.run/export", { anchor: { href: "https://wheelhouse.shipstack.run/export", target: "", hasDownload: true } }), here), false, "download");
  assert.equal(startsNavigation(click("https://wheelhouse.shipstack.run/workspace", { anchor: null }), here), false, "not a link");
});

test("modified, non-primary and already-handled clicks do not start it", () => {
  const to = "https://wheelhouse.shipstack.run/workspace";
  for (const over of [{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }, { button: 2 }, { defaultPrevented: true }]) {
    assert.equal(startsNavigation(click(to, over), here), false, JSON.stringify(over));
  }
});

test("a malformed address never throws", () => {
  assert.equal(startsNavigation(click("::not a url::"), here), false);
  assert.equal(startsNavigation(click("https://wheelhouse.shipstack.run/workspace"), "also not a url"), false);
});
