import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { useQuery } from "@tanstack/react-query";
import { createServices, ServicesProvider } from "../lib/services";
import { LiveRefresh, ProjectLiveRefresh, TeamLiveRefresh } from "./live-refresh";
import { FakeEventSource } from "../test/fake-event-source";
import { DEBOUNCE_MS, FALLBACK_POLL_MS } from "../lib/live-stream";

let hidden = false;
beforeEach(() => {
  vi.useFakeTimers();
  hidden = false;
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
});
afterEach(() => vi.useRealTimers());

/** Something on screen that reads data, so there is a query for a change to refresh. */
function Probe({ onRead, name }: { onRead: () => void; name: string }) {
  useQuery({ queryKey: [name], queryFn: async () => (onRead(), name), staleTime: Infinity });
  return null;
}

function mount(stream: React.ReactNode = <LiveRefresh path="/api/projects/AA/stream" />) {
  const services = createServices();
  const reads = { projects: 0, me: 0 };
  const view = render(
    <ServicesProvider services={services}>
      <Probe name="projects" onRead={() => reads.projects++} />
      <Probe name="me" onRead={() => reads.me++} />
      {stream}
    </ServicesProvider>,
  );
  return { ...view, reads, services };
}
const settle = () => act(async () => { await vi.advanceTimersByTimeAsync(0); });
const wait = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const stream = () => FakeEventSource.open.at(-1)!;

describe("a change reaches the screen", () => {
  test("the first 'ready' only records where the log is; a change then reads everything on screen again", async () => {
    const { reads } = mount();
    await settle();
    expect(reads.projects).toBe(1);
    stream().emit("ready", { seq: 5 });
    await wait(DEBOUNCE_MS * 2);
    expect(reads.projects).toBe(1);
    stream().emit("change", { seq: 6 });
    await wait(DEBOUNCE_MS + 10);
    expect(reads.projects).toBe(2);
  });

  test("but not 'who am I', which a change to a project cannot alter", async () => {
    const { reads } = mount();
    await settle();
    stream().emit("ready", { seq: 1 });
    stream().emit("change", { seq: 2 });
    await wait(DEBOUNCE_MS + 10);
    expect(reads.projects).toBe(2);
    expect(reads.me).toBe(1);
  });

  test("the panels that keep their own copy are told with a browser event carrying the position", async () => {
    mount();
    const seen: unknown[] = [];
    window.addEventListener("wheelhouse:changed", (e) => seen.push((e as CustomEvent).detail));
    stream().emit("ready", { seq: 1 });
    stream().emit("change", { seq: 9 });
    await wait(DEBOUNCE_MS + 10);
    expect(seen).toEqual([{ seq: 9 }]);
  });

  test("a burst of changes is one refresh", async () => {
    const { reads } = mount();
    await settle();
    stream().emit("ready", { seq: 1 });
    for (let seq = 2; seq < 12; seq++) stream().emit("change", { seq });
    await wait(DEBOUNCE_MS + 10);
    expect(reads.projects).toBe(2);
  });

  test("a 'ready' that shows the log moved while we were away refreshes", async () => {
    const { reads } = mount();
    await settle();
    stream().emit("ready", { seq: 5 });
    stream().fail();
    await wait(1100);
    stream().emit("ready", { seq: 9 });
    await wait(DEBOUNCE_MS + 10);
    expect(reads.projects).toBe(2);
  });
});

describe("which stream", () => {
  test("a project's changes, with the key encoded", async () => {
    mount(<ProjectLiveRefresh projectKey="A B" />);
    expect(stream().url).toBe("/api/projects/A%20B/stream");
  });
  test("the team's changes", async () => {
    mount(<TeamLiveRefresh />);
    expect(stream().url).toBe("/api/stream");
  });
});

describe("when the connection drops", () => {
  test("it reconnects after a growing pause, from where it left off", async () => {
    mount();
    stream().emit("ready", { seq: 5 });
    stream().emit("change", { seq: 7 });
    stream().fail();
    expect(FakeEventSource.open).toHaveLength(0);
    await wait(999);
    expect(FakeEventSource.open).toHaveLength(0);
    await wait(2);
    expect(stream().url).toBe("/api/projects/AA/stream?since=7");
    stream().fail();
    await wait(1500);
    expect(FakeEventSource.open).toHaveLength(0);
    await wait(600); // 2 seconds after the second failure
    expect(stream().url).toBe("/api/projects/AA/stream?since=7");
  });

  test("after three failures in a row it also reads on a timer, until the stream gets through again", async () => {
    const { reads } = mount();
    await settle();
    for (const pause of [1100, 2100]) {
      stream().fail();
      await wait(pause);
    }
    stream().fail(); // the third
    await settle(); // polling starts: the first poll only notes where it is
    const before = reads.projects;
    await wait(FALLBACK_POLL_MS + DEBOUNCE_MS + 50);
    expect(reads.projects).toBeGreaterThan(before);
    // The stream works again: the timer stops.
    await wait(4100);
    stream().emit("ready", { seq: 1 });
    const settled = reads.projects;
    await wait(FALLBACK_POLL_MS * 3);
    expect(reads.projects).toBe(settled);
  });
});

describe("a hidden tab", () => {
  test("closes the stream, and on coming back reopens it and catches up", async () => {
    const { reads } = mount();
    await settle();
    stream().emit("ready", { seq: 4 });
    hidden = true;
    document.dispatchEvent(new Event("visibilitychange"));
    expect(FakeEventSource.open).toHaveLength(0);
    hidden = false;
    document.dispatchEvent(new Event("visibilitychange"));
    expect(stream().url).toBe("/api/projects/AA/stream?since=4");
    await wait(DEBOUNCE_MS + 10);
    expect(reads.projects).toBe(2);
  });
});

describe("leaving the page", () => {
  test("closes the stream and stops reconnecting", async () => {
    const { unmount } = mount();
    const first = stream();
    stream().fail();
    unmount();
    expect(first.closed).toBe(true);
    await wait(60_000);
    expect(FakeEventSource.open).toHaveLength(0);
    expect(FakeEventSource.instances).toHaveLength(1);
  });
});
