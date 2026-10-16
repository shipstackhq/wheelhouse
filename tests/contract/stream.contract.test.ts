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

  test("a person can hold 12 streams; the 13th is refused with Retry-After, and closing one frees its slot", async () => {
    const as = { cookie: fx.a.memberSessionToken };
    const held: Awaited<ReturnType<typeof openSse>>[] = [];
    try {
      for (let i = 0; i < 12; i++) {
        const s = await openSse("/api/stream", as);
        assert.equal(s.status, 200, `stream ${i + 1} of 12`);
        held.push(s);
      }
      const over = await openSse("/api/stream", as);
      assert.equal(over.status, 429);
      assert.equal(over.headers.get("retry-after"), "10");
      assert.equal(over.body, "Too many open streams");
      held.pop()!.close();
      // The server notices a disconnect a moment later.
      let again;
      for (let i = 0; i < 30 && !again; i++) {
        const s = await openSse("/api/stream", as);
        if (s.status === 200) again = s;
        else await sleep(100);
      }
      assert.ok(again, "closing a stream never freed its slot");
      again.close();
    } finally {
      for (const s of held) s.close();
    }
  });

  test("opening and closing streams over and over never runs out of slots (no leak)", async () => {
    for (let i = 0; i < 30; i++) {
      const s = await openSse(`/api/projects/${fx.a.projectKey}/stream`, { cookie: fx.a.memberSessionToken });
      assert.equal(s.status, 200, `stream ${i + 1}`);
      await s.waitFor((e) => e.event === "ready");
      s.close();
      await sleep(25);
    }
  });
});
