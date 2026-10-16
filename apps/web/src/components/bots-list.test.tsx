import { test } from "vitest";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { BotsList, type Bot } from "./bots-list";
import type { SessionView } from "./session-row";

const session = (id: string, over: Partial<SessionView> = {}): SessionView => ({
  id,
  pending: 0,
  bucket: "h6",
  reading: true,
  lastSeenAt: new Date().toISOString(),
  branch: "main",
  ticket: "WH-48",
  ...over,
});
const bot = (over: Partial<Bot> = {}): Bot => ({ id: "key-1", name: "Laptop", pending: 0, sessions: [], lastUsedAt: new Date().toISOString(), ...over });
const noop = () => {};
const visible = (html: string) => html.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<[^>]+>/g, "|").replace(/\|+/g, "|").replace(/&#x27;/g, "'");

test("a bot is its name and queue on one line, with 'seen · N sessions' muted underneath", () => {
  const html = renderToStaticMarkup(
    <BotsList projectKey="WH" markAllSeen={noop} bots={[bot({ name: "Claude Atharva's Macbook Pro", pending: 36, sessions: [session("aaaa1111-x"), session("bbbb2222-x"), session("cccc3333-x")] })]} />,
  );
  const text = visible(html);
  assert.match(text, /Claude Atharva's Macbook Pro\|36 queued\|seen just now · 3 sessions\|mark all seen\|Last 6 hours/, "name, queue, muted line, hover-only reset, then the session groups");
  assert.ok(!text.includes("active session"), "the old wording is gone");
});

test("'mark all seen' is there for a bot with a queue but only appears on hover or focus", () => {
  const html = renderToStaticMarkup(<BotsList projectKey="WH" markAllSeen={noop} bots={[bot({ pending: 5 })]} />);
  assert.ok(html.includes("mark all seen"));
  assert.ok(html.includes("opacity-0") && html.includes("group-hover/bot:opacity-100") && html.includes("group-focus-within/bot:opacity-100"));
  assert.ok(html.includes("[@media(hover:none)]:opacity-100"), "always visible on touch screens");
  assert.ok(html.includes('name="keyId" value="key-1"') && html.includes('name="project" value="WH"'), "still resets this bot in this project");
});

test("a bot with nothing queued says in sync and has no reset button", () => {
  const html = renderToStaticMarkup(<BotsList projectKey="WH" markAllSeen={noop} bots={[bot()]} />);
  assert.ok(visible(html).includes("in sync"));
  assert.ok(!html.includes("mark all seen"));
});

test("wording for a bot that never connected and for a single session", () => {
  assert.ok(visible(renderToStaticMarkup(<BotsList projectKey="WH" markAllSeen={noop} bots={[bot({ lastUsedAt: null })]} />)).includes("never connected"));
  assert.ok(visible(renderToStaticMarkup(<BotsList projectKey="WH" markAllSeen={noop} bots={[bot({ sessions: [session("only1111-x")] })]} />)).includes("1 session|"));
});

test("sessions are listed under their bot, each with its action", () => {
  const html = renderToStaticMarkup(
    <BotsList projectKey="WH" markAllSeen={noop} bots={[bot({ sessions: [session("aaaa1111-x")] })]} sessionAction={(s) => <button>remove-{s.id}</button>} />,
  );
  assert.ok(visible(html).includes("Last 6 hours"));
  assert.ok(html.includes("aaaa1111") && html.includes("remove-aaaa1111-x"));
});
