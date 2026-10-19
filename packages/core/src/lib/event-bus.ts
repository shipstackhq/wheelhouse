/**
 * In-process fan-out of change signals to the browsers watching a team (WH-1).
 *
 * The events table stays the source of truth; this only tells open streams "something new is in it". It sits behind
 * the small `EventBus` interface so Postgres LISTEN/NOTIFY can replace it when more than one instance runs; today
 * there is exactly one app process, so a plain in-memory subscriber list is enough.
 *
 * Writes publish through `deferPublish`, which holds a signal until the transaction that produced it has committed.
 * Telling a browser to refresh before the commit would let it re-read the old data and miss the change.
 */

export type StreamEvent = {
  workspaceId: string;
  teamId: string;
  /** The events-table sequence. Absent on transient signals (an agent acked its queue), which are not in the log. */
  seq?: number;
  type: string;
  entity?: string;
  entityId?: string;
  actorKind?: string;
  actorName?: string;
  summary?: string;
};

export type Scope = { team: string } | { workspace: string };

export interface EventBus {
  publish(e: StreamEvent): void;
  subscribe(scope: Scope, fn: (e: StreamEvent) => void): () => void;
  /** Open subscriptions, so a test can prove none leak. */
  size(): number;
}

const key = (s: Scope) => ("team" in s ? `team:${s.team}` : `workspace:${s.workspace}`);

export class MemoryBus implements EventBus {
  private subs = new Map<string, Set<(e: StreamEvent) => void>>();

  publish(e: StreamEvent) {
    for (const k of [`team:${e.teamId}`, `workspace:${e.workspaceId}`]) {
      for (const fn of [...(this.subs.get(k) ?? [])]) {
        try {
          fn(e);
        } catch {
          /* one broken listener must not stop the others or the writer */
        }
      }
    }
  }

  subscribe(scope: Scope, fn: (e: StreamEvent) => void) {
    const k = key(scope);
    let set = this.subs.get(k);
    if (!set) this.subs.set(k, (set = new Set()));
    set.add(fn);
    return () => {
      const s = this.subs.get(k);
      if (!s) return;
      s.delete(fn);
      if (!s.size) this.subs.delete(k);
    };
  }

  size() {
    let n = 0;
    for (const s of this.subs.values()) n += s.size;
    return n;
  }
}

// One bus per process, kept across hot reloads so dev servers do not end up with two.
const g = globalThis as unknown as { __wheelhouseBus?: EventBus };
export const bus: EventBus = (g.__wheelhouseBus ??= new MemoryBus());

// ───────── after-commit publishing ─────────

/** Signals waiting for their transaction to commit, keyed by the transaction object that emit() was given. */
const pending = new WeakMap<object, StreamEvent[]>();

/** Publish now if `q` is the plain connection (each statement commits by itself), or after commit if it is a transaction. */
export function deferPublish(q: object, e: StreamEvent, target: EventBus = bus) {
  const list = pending.get(q);
  if (list) list.push(e);
  else target.publish(e);
}

type Transactional = { transaction: (fn: (tx: never) => Promise<unknown>, ...rest: never[]) => Promise<unknown> };

/**
 * Make `db.transaction` release the signals emitted inside it once it commits, and drop them if it rolls back.
 * Wrapping the one entry point means no call site has to remember to do it.
 */
export function publishAfterCommit<D extends object>(db: D, target: EventBus = bus): D {
  const d = db as unknown as Transactional;
  const original = d.transaction.bind(db);
  d.transaction = (async (fn: (tx: object) => Promise<unknown>, ...rest: never[]) => {
    const list: StreamEvent[] = [];
    const result = await (original as unknown as (f: (tx: object) => Promise<unknown>, ...r: never[]) => Promise<unknown>)(async (tx) => {
      pending.set(tx, list);
      return fn(tx);
    }, ...rest);
    for (const e of list) target.publish(e); // reached only when the transaction committed
    return result;
  }) as Transactional["transaction"];
  return db;
}
