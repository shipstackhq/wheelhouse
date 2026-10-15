import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { deferPublish, MemoryBus, publishAfterCommit, type StreamEvent } from "./event-bus";

const ev = (over: Partial<StreamEvent> = {}): StreamEvent => ({ teamId: "T1", projectId: "P1", seq: 1, type: "ticket.created", ...over });

describe("the in-process bus", () => {
  test("a project subscriber hears that project, a team subscriber hears every project of the team, and nobody hears anyone else's", () => {
    const bus = new MemoryBus();
    const p1: number[] = [], p2: number[] = [], t1: number[] = [], t2: number[] = [];
    bus.subscribe({ project: "P1" }, (e) => p1.push(e.seq!));
    bus.subscribe({ project: "P2" }, (e) => p2.push(e.seq!));
    bus.subscribe({ team: "T1" }, (e) => t1.push(e.seq!));
    bus.subscribe({ team: "T2" }, (e) => t2.push(e.seq!));
    bus.publish(ev({ seq: 1, projectId: "P1", teamId: "T1" }));
    bus.publish(ev({ seq: 2, projectId: "P2", teamId: "T1" }));
    bus.publish(ev({ seq: 3, projectId: "P9", teamId: "T9" }));
    assert.deepEqual(p1, [1]);
    assert.deepEqual(p2, [2]);
    assert.deepEqual(t1, [1, 2], "the team stream carries all of its projects");
    assert.deepEqual(t2, [], "another team hears nothing");
  });

  test("unsubscribing stops delivery and leaves nothing behind", () => {
    const bus = new MemoryBus();
    const heard: number[] = [];
    const off = bus.subscribe({ project: "P1" }, (e) => heard.push(e.seq!));
    assert.equal(bus.size(), 1);
    bus.publish(ev({ seq: 1 }));
    off();
    off(); // twice is harmless
    bus.publish(ev({ seq: 2 }));
    assert.deepEqual(heard, [1]);
    assert.equal(bus.size(), 0, "no subscriber is leaked");
  });

  test("a listener that throws does not stop the others or the writer", () => {
    const bus = new MemoryBus();
    const heard: number[] = [];
    bus.subscribe({ project: "P1" }, () => {
      throw new Error("broken tab");
    });
    bus.subscribe({ project: "P1" }, (e) => heard.push(e.seq!));
    assert.doesNotThrow(() => bus.publish(ev({ seq: 7 })));
    assert.deepEqual(heard, [7]);
  });

  test("a listener may unsubscribe itself while it is being called", () => {
    const bus = new MemoryBus();
    const heard: string[] = [];
    const off = bus.subscribe({ project: "P1" }, () => {
      heard.push("a");
      off();
    });
    bus.subscribe({ project: "P1" }, () => heard.push("b"));
    bus.publish(ev());
    bus.publish(ev({ seq: 2 }));
    assert.deepEqual(heard, ["a", "b", "b"]);
  });
});

describe("publishing only after the transaction commits", () => {
  // A stand-in for the database: runs the callback, rejects if it throws, otherwise "commits".
  const fakeDb = () => ({
    committed: [] as string[],
    async transaction<T>(fn: (tx: object) => Promise<T>): Promise<T> {
      const tx = {};
      const r = await fn(tx);
      this.committed.push("commit");
      return r;
    },
  });

  test("a signal emitted inside a transaction is published after the commit, not before", async () => {
    const bus = new MemoryBus();
    const db = publishAfterCommit(fakeDb(), bus);
    const log: string[] = [];
    bus.subscribe({ project: "P1" }, (e) => log.push(`heard ${e.seq} after ${db.committed.length} commit(s)`));
    await db.transaction(async (tx) => {
      deferPublish(tx, ev({ seq: 5 }), bus);
      assert.deepEqual(log, [], "nothing is heard while the transaction is still open");
    });
    assert.deepEqual(log, ["heard 5 after 1 commit(s)"]);
  });

  test("a rolled-back transaction publishes nothing", async () => {
    const bus = new MemoryBus();
    const db = publishAfterCommit(fakeDb(), bus);
    const heard: number[] = [];
    bus.subscribe({ project: "P1" }, (e) => heard.push(e.seq!));
    await assert.rejects(
      db.transaction(async (tx) => {
        deferPublish(tx, ev({ seq: 9 }), bus);
        throw new Error("constraint violated");
      }),
      /constraint violated/,
    );
    assert.deepEqual(heard, []);
  });

  test("outside a transaction a signal goes out at once", () => {
    const bus = new MemoryBus();
    const heard: number[] = [];
    bus.subscribe({ project: "P1" }, (e) => heard.push(e.seq!));
    deferPublish({}, ev({ seq: 3 }), bus);
    assert.deepEqual(heard, [3]);
  });

  test("two transactions running at once each release only their own signals", async () => {
    const bus = new MemoryBus();
    const db = publishAfterCommit(fakeDb(), bus);
    const heard: number[] = [];
    bus.subscribe({ project: "P1" }, (e) => heard.push(e.seq!));
    let releaseA!: () => void;
    const gateA = new Promise<void>((r) => (releaseA = r));
    const a = db.transaction(async (tx) => {
      deferPublish(tx, ev({ seq: 1 }), bus);
      await gateA; // A stays open
    });
    await db.transaction(async (tx) => {
      deferPublish(tx, ev({ seq: 2 }), bus);
    });
    assert.deepEqual(heard, [2], "B's commit does not release A's signal");
    releaseA();
    await a;
    assert.deepEqual(heard, [2, 1]);
  });

  test("the result and the arguments of the wrapped transaction are passed through", async () => {
    const bus = new MemoryBus();
    const db = publishAfterCommit(fakeDb(), bus);
    assert.equal(await db.transaction(async () => "value"), "value");
  });
});
