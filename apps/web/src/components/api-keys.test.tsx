import { test } from "vitest";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { ActiveKeys, splitKeys, type KeyRow } from "./active-keys";
import { RevokedKeys } from "./revoked-keys";

const key = (id: string, over: Partial<KeyRow> = {}): KeyRow => ({ id, name: `Key ${id}`, prefix: `wh_${id}`, lastUsedAt: null, revokedAt: null, ...over });
const revokedKey = (id: string) => key(id, { revokedAt: new Date(Date.now() - 2 * 86400_000).toISOString() });
const noop = () => {};
const visible = (html: string) => html.replace(/<[^>]+>/g, "|").replace(/\|+/g, "|");

test("active keys show name, prefix and when they were last used, each with mark-all-seen and revoke", () => {
  const html = renderToStaticMarkup(<ActiveKeys keys={[key("a1", { lastUsedAt: new Date().toISOString() }), key("b2")]} markAllSeen={noop} revoke={noop} />);
  const text = visible(html);
  assert.ok(text.includes("Key a1") && text.includes("wh_a1…") && text.includes("used just now"));
  assert.ok(text.includes("Key b2") && text.includes("never used"));
  assert.equal(html.match(/Mark all seen/g)?.length, 2);
  assert.equal(html.match(/>Revoke</g)?.length, 2);
});

test("with no active keys it says so instead of rendering an empty list", () => {
  const html = renderToStaticMarkup(<ActiveKeys keys={[]} markAllSeen={noop} revoke={noop} />);
  assert.match(visible(html), /No active keys\. Create one above\./);
  assert.ok(!html.includes("<ul"));
});

test("revoked keys are collapsed behind a button that shows how many there are", () => {
  const html = renderToStaticMarkup(<RevokedKeys keys={[revokedKey("r1"), revokedKey("r2"), revokedKey("r3")]} />);
  assert.ok(html.includes("Show revoked keys (3)"));
  assert.ok(html.includes('aria-expanded="false"'));
  for (const n of ["r1", "r2", "r3"]) assert.ok(!html.includes(`Key ${n}`), `${n} stays hidden until the button is pressed`);
  assert.ok(!html.includes("<ul"));
});

test("expanded, revoked keys are listed struck through with when they were revoked, and the button hides them again", () => {
  const html = renderToStaticMarkup(<RevokedKeys keys={[revokedKey("r1"), revokedKey("r2")]} defaultOpen />);
  const text = visible(html);
  assert.ok(html.includes('aria-expanded="true"') && html.includes("Hide revoked keys"));
  assert.ok(text.includes("Key r1") && text.includes("wh_r1…") && text.includes("revoked 2d ago"));
  assert.ok(html.includes("line-through"));
});

test("a revoked key has no actions: nothing can revoke it again or reset its queue", () => {
  const html = renderToStaticMarkup(<RevokedKeys keys={[revokedKey("r1")]} defaultOpen />);
  assert.ok(!html.includes("<form") && !html.includes("Mark all seen") && !html.includes(">Revoke<"));
});

test("with no revoked keys nothing is rendered, not even the button", () => {
  assert.equal(renderToStaticMarkup(<RevokedKeys keys={[]} />), "");
  assert.equal(renderToStaticMarkup(<RevokedKeys keys={[]} defaultOpen />), "");
});

test("splitKeys keeps revoked keys out of the active list and puts the most recently revoked first", () => {
  const old = key("old", { revokedAt: new Date(Date.now() - 9 * 86400_000).toISOString() });
  const recent = key("recent", { revokedAt: new Date(Date.now() - 1 * 86400_000).toISOString() });
  const { active, revoked } = splitKeys([key("a"), old, key("b"), recent]);
  assert.deepEqual(active.map((k) => k.id), ["a", "b"], "live keys keep their order");
  assert.deepEqual(revoked.map((k) => k.id), ["recent", "old"]);
  const html = renderToStaticMarkup(<ActiveKeys keys={active} markAllSeen={noop} revoke={noop} />);
  assert.ok(html.includes("Key a") && !html.includes("Key old") && !html.includes("Key recent"));
});

test("splitKeys copes with only active, only revoked, or no keys", () => {
  assert.deepEqual(splitKeys([]), { active: [], revoked: [] });
  assert.equal(splitKeys([key("a")]).revoked.length, 0);
  assert.equal(splitKeys([revokedKey("r")]).active.length, 0);
});
