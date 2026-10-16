import { Injectable, type BeforeApplicationShutdown } from "@nestjs/common";

/**
 * The live streams that are open right now. A stream never ends on its own, and Nest's shutdown waits for open connections,
 * so without this a SIGTERM during a deploy would hang until the process was killed. On shutdown every stream is told to end
 * (before Nest starts waiting), which closes its connection and frees its place on the event bus.
 */
@Injectable()
export class StreamRegistry implements BeforeApplicationShutdown {
  private readonly open = new Set<AbortController>();

  /** Remember a stream; the returned function forgets it. */
  track(stream: AbortController) {
    this.open.add(stream);
    return () => {
      this.open.delete(stream);
    };
  }

  get size() {
    return this.open.size;
  }

  beforeApplicationShutdown() {
    for (const s of this.open) s.abort();
    this.open.clear();
  }
}
