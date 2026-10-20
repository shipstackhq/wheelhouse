import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";
import { MotionGlobalConfig } from "motion/react";

afterEach(() => cleanup());

// Animations finish at once in tests, so what a click opens or closes is there (or gone) when the next line looks.
MotionGlobalConfig.skipAnimations = true;

// jsdom does not have these; the real browsers do.
if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}
if (!("ResizeObserver" in window)) {
  (window as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

// Radix menus and selects use these; jsdom has none of them.
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
}
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};

import { FakeEventSource } from "./fake-event-source";
import { beforeEach } from "vitest";
beforeEach(() => {
  FakeEventSource.reset();
  document.cookie = "wh_last_team=; path=/; max-age=0";
  try {
    localStorage.clear();
  } catch {
    /* no storage */
  }
});
