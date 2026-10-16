import { test } from "vitest";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionGroups, SessionRow, sessionDetails, shortSession, type SessionView } from "./session-row";

const view = (id: string, over: Partial<SessionView> = {}): SessionView => ({
  id,
  pending: 0,
  bucket: "h6",
  reading: true,
  lastSeenAt: new Date().toISOString(),
  branch: null,
  ticket: null,
  ...over,
});
/** What a person reads: markup with tags (and so attributes) removed, runs of tags collapsed to one separator. */
const visible = (html: string) => html.replace(/<[^>]+>/g, "|").replace(/\|+/g, "|");

const FULL = "6c8d2637-dfcb-41b7-bcfd-b868fced8b27";

test("a session is one line: short id and its queue; ticket, project, branch and time are not on screen", () => {
  const html = renderToStaticMarkup(<SessionRow s={view(FULL, { pending: 3, branch: "main", ticket: "WH-45", projectKey: "WH" })} />);
  assert.equal(visible(html), "|6c8d2637|3 queued|");
  for (const clutter of ["main", "just now", "WH", "dfcb-41b7"]) assert.ok(!visible(html).includes(clutter), `${clutter} stays out of the row`);
});

test("everything the row leaves out is in its details: full id, ticket, project, branch, time, queue", () => {
  const lines = sessionDetails(view(FULL, { pending: 3, branch: "main", ticket: "WH-45", projectKey: "WH" }));
  assert.deepEqual(lines, [`Session ${FULL}`, "Working on WH-45", "WH · branch main", "Active just now", "3 changes queued"]);
  assert.deepEqual(sessionDetails(view("abc")), ["Session abc", "Active just now", "Caught up"], "no ticket or branch: no empty lines");
  assert.equal(sessionDetails(view("abc", { pending: 1 })).at(-1), "1 change queued");
  assert.equal(sessionDetails(view("abc", { reading: false })).at(-1), "Has not read its queue yet");
});

test("the details are also the row's accessible label, so keyboard and screen reader users get them", () => {
  const html = renderToStaticMarkup(<SessionRow s={view(FULL, { pending: 3, branch: "main", ticket: "WH-45", projectKey: "WH" })} />);
  assert.ok(html.includes('tabindex="0"'), "focusable");
  assert.ok(html.includes("Working on WH-45") && html.includes("WH · branch main"), "in the aria-label");
});

test("a caught-up session says in sync; one that never read its queue says 'not reading yet'", () => {
  const sync = renderToStaticMarkup(<SessionRow s={view("abc")} />);
  assert.ok(visible(sync).includes("in sync"));
  const idle = renderToStaticMarkup(<SessionRow s={view("abc", { reading: false })} />);
  assert.ok(visible(idle).includes("not reading yet") && !visible(idle).includes("in sync"));
});

test("the remove action takes room on the row but only shows on hover or focus", () => {
  const html = renderToStaticMarkup(<SessionRow s={view("abc")} action={<button>remove</button>} />);
  assert.ok(visible(html).endsWith("|in sync|remove|"), "after the queue count");
  assert.match(html, /opacity-0[^"]*group-hover\/row:opacity-100|group-hover\/row:opacity-100[^"]*opacity-0/);
  assert.ok(html.includes("group-focus-within/row:opacity-100"), "keyboard focus reveals it");
  assert.ok(html.includes("[@media(hover:none)]:opacity-100"), "always visible on touch screens");
  assert.ok(!renderToStaticMarkup(<SessionRow s={view("abc")} />).includes("opacity-0"), "no action, no placeholder");
});

test("groups show only the buckets that have sessions, newest first, with a count", () => {
  const html = renderToStaticMarkup(<SessionGroups sessions={[view("old11111", { bucket: "d7" }), view("new22222", { bucket: "h6" }), view("old33333", { bucket: "d7" })]} />);
  const text = visible(html);
  assert.ok(text.indexOf("Last 6 hours") < text.indexOf("1–7 days ago"), "newest bucket first");
  assert.match(text, /Last 6 hours\s*\|\(1\)/);
  assert.match(text, /1–7 days ago\s*\|\(2\)/);
  assert.ok(!text.includes("6–12 hours") && !text.includes("12–24 hours"), "empty buckets aren't rendered");
});

test("each session gets its own action, and no sessions renders nothing", () => {
  const html = renderToStaticMarkup(<SessionGroups sessions={[view("keep1111"), view("drop2222")]} action={(s) => <button>remove-{s.id}</button>} />);
  assert.ok(html.includes("remove-keep1111") && html.includes("remove-drop2222"));
  assert.equal(renderToStaticMarkup(<SessionGroups sessions={[]} action={() => <b>x</b>} />), "");
  assert.equal(shortSession("6c8d2637-dfcb"), "6c8d2637");
});
