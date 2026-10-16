import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { asKey, fx, openSse, sleep, unique, v1ok } from "./lib/http";
import { expectGolden } from "./lib/golden";
import { shape } from "./lib/shape";

const A = asKey(fx.a.apiKey);
const B = asKey(fx.b.apiKey);

describe("GET /api/stream and /api/projects/:key/stream", () => {
  test("not signed in: 401; an API key is refused with 403 (streams are for people)", async () => {
    const anon = await openSse("/api/stream");
    assert.equal(anon.status, 401);
    const key = await openSse("/api/stream", { key: fx.a.apiKey });
    assert.equal(key.status, 403);
    const project = await openSse(`/api/projects/${fx.a.projectKey}/stream`, { key: fx.a.apiKey });
    assert.equal(project.status, 403);
  });

  test("another team's project is a 404, not a stream", async () => {
    const r = await openSse(`/api/projects/${fx.b.projectKey}/stream`, { cookie: fx.a.sessionToken });
    assert.equal(r.status, 404);
  });

  test("a stream sends the SSE headers, a ready marker, and a change event when something is written", async () => {
    const s = await openSse(`/api/projects/${fx.a.projectKey}/stream`, { cookie: fx.a.sessionToken });
    try {
      assert.equal(s.status, 200);
      assert.equal(s.headers.get("content-type"), "text/event-stream; charset=utf-8");
      assert.equal(s.headers.get("cache-control"), "no-cache, no-transform");
      assert.equal(s.headers.get("x-accel-buffering"), "no");
      const ready = await s.waitFor((e) => e.event === "ready");
      assert.match(ready.id ?? "", /^\d+$/);
      assert.equal(typeof ready.data.seq, "number");

      const title = unique("streamed");
      await v1ok(A, "create_ticket", { project: fx.a.projectKey, title });
      const change = await s.waitFor((e) => e.event === "change" && String(e.data?.summary).includes(title));
      assert.match(change.id ?? "", /^\d+$/, "a change from the log carries an id so the browser can resume");
      expectGolden("sse-change-event", shape(change.data));
    } finally {
      s.close();
    }
  });

  test("resuming with Last-Event-ID or ?since= replays what was missed, in order", async () => {
    const title = unique("resume");
    const made = await v1ok(A, "create_ticket", { project: fx.a.projectKey, title });
    await v1ok(A, "comment", { ticket: made.ref, body: "second change" });
    const all = await openSse(`/api/projects/${fx.a.projectKey}/stream?since=0`, { cookie: fx.a.sessionToken });
    try {
      const created = await all.waitFor((e) => e.event === "change" && String(e.data?.summary).includes(title));
      const resumed = await openSse(`/api/projects/${fx.a.projectKey}/stream`, { cookie: fx.a.sessionToken, headers: { "last-event-id": String(Number(created.id) - 1) } });
      try {
        const first = await resumed.waitFor((e) => e.event === "change");
        assert.equal(first.id, created.id, "starts exactly after the id it was given");
        await resumed.waitFor((e) => e.event === "change" && /commented/.test(String(e.data?.summary)));
      } finally {
        resumed.close();
      }
    } finally {
      all.close();
    }
  });

  test("a team never receives another team's events, on either stream", async () => {
    const teamA = await openSse("/api/stream", { cookie: fx.a.sessionToken });
    const teamB = await openSse("/api/stream", { cookie: fx.b.sessionToken });
    const projB = await openSse(`/api/projects/${fx.b.projectKey}/stream`, { cookie: fx.b.sessionToken });
    try {
      await teamA.waitFor((e) => e.event === "ready");
      await teamB.waitFor((e) => e.event === "ready");
      await projB.waitFor((e) => e.event === "ready");
      const a = unique("only-a");
      const b = unique("only-b");
      await v1ok(A, "create_ticket", { project: fx.a.projectKey, title: a });
      await v1ok(B, "create_ticket", { project: fx.b.projectKey, title: b });
      await teamA.waitFor((e) => String(e.data?.summary).includes(a));
      await teamB.waitFor((e) => String(e.data?.summary).includes(b));
      await projB.waitFor((e) => String(e.data?.summary).includes(b));
      await sleep(500);
      for (const [name, s, other] of [["team A", teamA, b], ["team B", teamB, a], ["project B", projB, a]] as const) {
        assert.ok(!s.events.some((e) => String(e.data?.summary).includes(other)), `${name} received another team's event`);
      }
    } finally {
      teamA.close();
      teamB.close();
      projB.close();
    }
  });
});
