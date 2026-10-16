/** An EventSource whose messages the test sends. jsdom does not have one. */
type Listener = (ev: MessageEvent) => void;

export class FakeEventSource {
  static instances: FakeEventSource[] = [];
  static reset() {
    FakeEventSource.instances = [];
  }
  /** The streams currently open, newest last. */
  static get open() {
    return FakeEventSource.instances.filter((i) => !i.closed);
  }

  closed = false;
  onerror: (() => void) | null = null;
  private listeners = new Map<string, Listener[]>();
  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, fn: Listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  close() {
    this.closed = true;
  }
  /** The server says something. */
  emit(type: "ready" | "resync" | "change", data: unknown = {}) {
    for (const fn of this.listeners.get(type) ?? []) fn({ data: JSON.stringify(data) } as MessageEvent);
  }
  /** The connection drops. */
  fail() {
    this.onerror?.();
  }
}

(globalThis as unknown as { EventSource: typeof FakeEventSource }).EventSource = FakeEventSource;
