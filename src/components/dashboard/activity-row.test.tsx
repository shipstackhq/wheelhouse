import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { ActivityRow, type ActivityEvent } from "./activity-row";
import { CollapsibleList } from "../collapsible-list";

const visible = (html: string) => html.replace(/<[^>]+>/g, "|").replace(/\|+/g, "|").replace(/&#x27;/g, "'");
const ev = (over: Partial<ActivityEvent> = {}): ActivityEvent => ({
  seq: 1,
  projectKey: "WH",
  actorKind: "human",
  actorName: "Demo",
  summary: "moved WH-47 from In Progress → Review",
  createdAt: new Date(),
  ...over,
});

test("an event is two lines: project and what happened, then who and when", () => {
  const html = renderToStaticMarkup(<ActivityRow e={ev()} />);
  assert.equal(visible(html), "|WH|moved WH-47 from In Progress → Review|Demo · just now|");
  assert.match(html, /<a [^>]*href="\/p\/WH\/activity"/, "still links to the project's activity page");
});

test("an agent is marked with the robot, and a long name sits on the second line, truncated rather than squeezing the summary", () => {
  const html = renderToStaticMarkup(<ActivityRow e={ev({ actorKind: "agent", actorName: "Claude Atharva's Macbook Pro" })} />);
  assert.equal(visible(html), "|WH|moved WH-47 from In Progress → Review|🤖 Claude Atharva's Macbook Pro · just now|");
  assert.ok(html.includes("truncate"));
});

test("twelve events show three, and the full list is behind '+N more'", () => {
  const rows = Array.from({ length: 12 }, (_, i) => <ActivityRow key={i} e={ev({ seq: i, summary: `event ${i}` })} />);
  const text = visible(renderToStaticMarkup(<CollapsibleList limit={3} title="Recent activity">{rows}</CollapsibleList>));
  assert.ok(text.includes("event 0") && text.includes("event 2") && !text.includes("event 3"));
  assert.ok(text.includes("+9 more"));
});
