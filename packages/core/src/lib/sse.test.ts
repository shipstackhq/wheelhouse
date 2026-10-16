import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { MemoryBus, type StreamEvent } from "./event-bus";
import { eventStream, formatChange, formatHeartbeat, formatMarker, parseSince, REPLAY_CAP, type StreamDeps } from "./sse";

const ev = (seq: number | undefined, over: Partial<StreamEvent> = {}): StreamEvent => ({ teamId: "T", projectId: "P", seq, type: "ticket.moved", summary: `s${seq}`, ...over });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Read everything the stream has produced so far (and whatever arrives in the next few ms). */
function collect(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let text = "";
  let done = false;
  (async () => {
    for (;;) {
      const r = await reader.read();
      if (r.done) {
        done = true;
        return;
      }
      text += dec.decode(r.value);
    }
  })();
  return { text: () => text, isDone: () => done, cancel: () => reader.cancel() };
}

function harness(over: Partial<StreamDeps> & { rows?: StreamEvent[]; latest?: number } = {}) {
  const bus = new MemoryBus();
  const ctl = new AbortController();
  let closed = 0;
  const stream = eventStream({
    subscribe: (fn) => bus.subscribe({ project: "P" }, fn),
    replay: async (since, limit) => (over.rows ?? []).filter((r) => r.seq! > since).slice(0, limit),
    latestSeq: async () => over.latest ?? 0,
    since: null,
    signal: ctl.signal,
    heartbeatMs: 20,
    onClose: () => closed++,
    ...over,
  });
  return { bus, ctl, stream, closed: () => closed };
}

describe("wire format", () => {
  test("a change from the log carries its position as the event id, so a browser can resume", () => {
    const out = formatChange(ev(42, { entity: "ticket", entityId: "t1", actorKind: "agent", actorName: "Laptop" }));
    assert.match(out, /^id: 42\nevent: change\ndata: \{.*\}\n\n$/);
    const data = JSON.parse(out.split("data: ")[1]);
    assert.deepEqual(Object.keys(data).sort(), ["actorKind", "actorName", "entity", "entityId", "seq", "summary", "type"]);
  });

  test("a transient signal has no id, because it is not in the log", () => {
    assert.ok(!formatChange(ev(undefined, { type: "queue.changed" })).includes("id:"));
  });

  test("markers and heartbeats", () => {
    assert.equal(formatMarker("ready", 7), 'id: 7\nevent: ready\ndata: {"seq":7}\n\n');
    assert.equal(formatMarker("resync", 9), 'id: 9\nevent: resync\ndata: {"seq":9}\n\n');
    assert.ok(formatHeartbeat().startsWith(":"), "a comment line, ignored by EventSource");
  });

  test("the resume position comes from the Last-Event-ID header or ?since=, and only if it is a plain number", () => {
    assert.equal(parseSince("12", null), 12);
    assert.equal(parseSince(null, "30"), 30);
    assert.equal(parseSince("12", "30"), 12, "the header wins");
    assert.equal(parseSince("0", null), 0);
    for (const bad of ["abc", "-1", "1.5", "", "1e3", " ", "12; drop table", "9".repeat(20)]) assert.equal(parseSince(bad, null), null, JSON.stringify(bad));
    assert.equal(parseSince(null, null), null);
  });
});

describe("the stream", () => {
  test("a first connection says where the log is, then forwards live changes", async () => {
    const h = harness({ latest: 100 });
    const out = collect(h.stream);
    await wait(10);
    assert.match(out.text(), /^retry: 3000\n\n/);
    assert.ok(out.text().includes('event: ready\ndata: {"seq":100}'));
    h.bus.publish(ev(101));
    h.bus.publish(ev(102));
    await wait(10);
    assert.ok(out.text().includes("id: 101\nevent: change") && out.text().includes("id: 102\nevent: change"));
    h.ctl.abort();
  });

  test("a reconnecting browser is caught up from its position, in order, and nothing earlier is repeated", async () => {
    const h = harness({ since: 10, rows: [ev(9), ev(11), ev(12), ev(13)], latest: 13 });
    const out = collect(h.stream);
    await wait(10);
    const ids = [...out.text().matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
    assert.deepEqual(ids, [11, 12, 13]);
    assert.ok(!out.text().includes("event: ready"), "a resume does not start over");
    h.ctl.abort();
  });

  test("too far behind: one resync instead of a flood of events", async () => {
    const rows = Array.from({ length: REPLAY_CAP + 50 }, (_, i) => ev(i + 1));
    const h = harness({ since: 0, rows, latest: REPLAY_CAP + 50 });
    const out = collect(h.stream);
    await wait(20);
    assert.ok(out.text().includes(`event: resync\ndata: {"seq":${REPLAY_CAP + 50}}`));
    assert.equal((out.text().match(/event: change/g) ?? []).length, 0);
    h.ctl.abort();
  });

  test("a change that lands during the replay is sent once, after it, and not lost", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const h = harness({
      since: 10,
      replay: async () => {
        await gate; // the database is slow
        return [ev(11), ev(12)];
      },
    });
    const out = collect(h.stream);
    await wait(5);
    h.bus.publish(ev(12)); // already in the replay: must not be sent twice
    h.bus.publish(ev(13)); // new: must not be lost
    release();
    await wait(20);
    const ids = [...out.text().matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
    assert.deepEqual(ids, [11, 12, 13]);
    h.ctl.abort();
  });

  test("a browser whose position is ahead of the log (a restored backup) is told to start over", async () => {
    const h = harness({ since: 500, rows: [], latest: 40 });
    const out = collect(h.stream);
    await wait(10);
    assert.ok(out.text().includes('event: resync\ndata: {"seq":40}'));
    h.bus.publish(ev(41));
    await wait(5);
    assert.ok(out.text().includes("id: 41\nevent: change"), "and then follows the log from there");
    h.ctl.abort();
  });

  test("a browser that is simply up to date is sent nothing it does not need", async () => {
    const h = harness({ since: 40, rows: [], latest: 40 });
    const out = collect(h.stream);
    await wait(10);
    assert.ok(!out.text().includes("event:"), "no ready, no resync, no change");
    h.ctl.abort();
  });

  test("an old signal is not sent again", async () => {
    const h = harness({ latest: 50 });
    const out = collect(h.stream);
    await wait(5);
    h.bus.publish(ev(50));
    h.bus.publish(ev(49));
    await wait(5);
    assert.equal((out.text().match(/event: change/g) ?? []).length, 0);
    h.ctl.abort();
  });

  test("transient signals pass straight through", async () => {
    const h = harness({ latest: 5 });
    const out = collect(h.stream);
    await wait(5);
    h.bus.publish(ev(undefined, { type: "queue.changed" }));
    h.bus.publish(ev(undefined, { type: "queue.changed" }));
    await wait(5);
    assert.equal((out.text().match(/queue\.changed/g) ?? []).length, 2);
    h.ctl.abort();
  });

  test("an idle stream sends heartbeats", async () => {
    const h = harness({ latest: 1 });
    const out = collect(h.stream);
    await wait(70);
    assert.ok((out.text().match(/: keep-alive/g) ?? []).length >= 2);
    h.ctl.abort();
  });

  test("a database error during the catch-up becomes a resync, and the stream carries on", async () => {
    const h = harness({
      since: 5,
      replay: async () => {
        throw new Error("connection reset");
      },
    });
    const out = collect(h.stream);
    await wait(10);
    assert.ok(out.text().includes("event: resync"));
    h.bus.publish(ev(6));
    await wait(5);
    assert.ok(out.text().includes("id: 6\nevent: change"));
    h.ctl.abort();
  });
});

describe("closing", () => {
  test("when the client goes away the subscription, the heartbeat and the connection slot are all released, once", async () => {
    const h = harness({ latest: 1 });
    const out = collect(h.stream);
    await wait(10);
    assert.equal(h.bus.size(), 1);
    h.ctl.abort();
    await wait(30);
    assert.equal(h.bus.size(), 0, "no leaked subscriber");
    assert.equal(h.closed(), 1);
    assert.ok(out.isDone());
    const before = out.text().length;
    await wait(60);
    assert.equal(out.text().length, before, "no heartbeat after close");
    h.ctl.abort();
    assert.equal(h.closed(), 1, "closing twice is harmless");
  });

  test("cancelling the response body (the browser closes the tab) releases everything too", async () => {
    const h = harness({ latest: 1 });
    const out = collect(h.stream);
    await wait(10);
    await out.cancel();
    await wait(10);
    assert.equal(h.bus.size(), 0);
    assert.equal(h.closed(), 1);
  });

  test("a request that was already aborted never subscribes", async () => {
    const ctl = new AbortController();
    ctl.abort();
    const bus = new MemoryBus();
    let closed = 0;
    const stream = eventStream({ subscribe: (fn) => bus.subscribe({ project: "P" }, fn), replay: async () => [], latestSeq: async () => 0, since: null, signal: ctl.signal, onClose: () => closed++ });
    const out = collect(stream);
    await wait(10);
    assert.equal(bus.size(), 0);
    assert.equal(closed, 1);
    assert.ok(out.isDone());
  });
});
