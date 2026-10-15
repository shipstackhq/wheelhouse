import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { Spinner } from "./spinner";
import { Skeleton, PageSkeleton } from "./skeleton";
import { SubmitButton } from "./submit-button";
import { LinkPending, LINK_SPINNER_DELAY_MS } from "./link-pending";
import AppLoading from "../app/(app)/loading";
import ProjectLoading from "../app/(app)/p/[key]/loading";

const APP = path.join(process.cwd(), "src", "app", "(app)");

test("the spinner is decorative and stands still for people who ask for less motion", () => {
  const html = renderToStaticMarkup(<Spinner />);
  assert.ok(html.includes('aria-hidden="true"'));
  assert.ok(html.includes("motion-safe:animate-spin"), "it only spins when motion is allowed");
});

test("a skeleton block is hidden from screen readers and only pulses when motion is allowed", () => {
  const html = renderToStaticMarkup(<Skeleton className="h-4" />);
  assert.ok(html.includes('aria-hidden="true"') && html.includes("motion-safe:animate-pulse") && html.includes("h-4"));
});

test("a page skeleton is announced once as busy, with a label, not block by block", () => {
  const html = renderToStaticMarkup(<PageSkeleton label="Loading the board" rows={3} />);
  assert.ok(html.includes('role="status"') && html.includes('aria-busy="true"'));
  assert.ok(html.includes("Loading the board…") && html.includes("sr-only"));
  assert.equal((html.match(/h-12/g) ?? []).length, 3, "one placeholder per row asked for");
});

test("a submit button looks and behaves like the plain button it replaces when nothing is pending", () => {
  const html = renderToStaticMarkup(
    <form>
      <SubmitButton className="btn btn-danger" title="Revoke this key">Revoke</SubmitButton>
    </form>,
  );
  assert.ok(html.includes("btn btn-danger") && html.includes('title="Revoke this key"') && html.includes(">Revoke</button>"));
  assert.ok(!html.includes("disabled") && !html.includes("aria-busy") && !html.includes("<svg"), "no spinner, enabled, until it is submitted");
});

test("a submit button can still be disabled by its caller and can carry its own action", () => {
  const html = renderToStaticMarkup(
    <form>
      <SubmitButton disabled className="btn">Create</SubmitButton>
    </form>,
  );
  assert.ok(html.includes("disabled"));
});

test("a link shows no spinner until its navigation is pending, and then only after a short delay", () => {
  assert.equal(renderToStaticMarkup(<LinkPending />), "");
  assert.ok(LINK_SPINNER_DELAY_MS >= 100 && LINK_SPINNER_DELAY_MS <= 300, "long enough not to flicker, short enough to feel immediate");
});

test("the app shell and the project section both have a loading page, and it is a busy skeleton", () => {
  for (const Page of [AppLoading, ProjectLoading]) {
    const html = renderToStaticMarkup(<Page />);
    assert.ok(html.includes('aria-busy="true"') && html.includes('role="status"'));
  }
});

test("every page in the app has a loading boundary at or above it, so a slow click never freezes", () => {
  const missing: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === "page.tsx") {
        let d = path.dirname(full);
        let found = false;
        for (;;) {
          if (fs.existsSync(path.join(d, "loading.tsx"))) {
            found = true;
            break;
          }
          if (d === APP) break;
          d = path.dirname(d);
        }
        if (!found) missing.push(path.relative(APP, full));
      }
    }
  };
  walk(APP);
  assert.deepEqual(missing, []);
});

test("the project header does not wait for the queue: the layout leaves that to a streamed component", () => {
  const layout = fs.readFileSync(path.join(APP, "p", "[key]", "layout.tsx"), "utf8");
  assert.ok(!layout.includes("queueStatus"), "the layout must not await the queue itself");
  assert.ok(layout.includes("<Suspense") && layout.includes("ProjectQueueMenu"));
});
