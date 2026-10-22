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
// The rich text editors place their tooltips and menus at the caret, which jsdom cannot measure.
if (!Range.prototype.getBoundingClientRect) {
  const empty = () => ({ x: 0, y: 0, top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0, toJSON() {} });
  Range.prototype.getBoundingClientRect = empty as () => DOMRect;
  Range.prototype.getClientRects = (() => []) as unknown as () => DOMRectList;
}

import { FakeEventSource } from "./fake-event-source";
import { beforeEach } from "vitest";
beforeEach(() => {
  FakeEventSource.reset();
  document.cookie = "wh_last_team=; path=/; max-age=0";
  try {
    localStorage.clear();
    // The team page opens as a list unless a team has chosen otherwise; the board tests were written for the board, so they start there.
    // The tests of the list and of the layout choice clear this to see the real default.
    localStorage.setItem("wh:layout:AA", "board");
    localStorage.setItem("wh:layout:BB", "board");
  } catch {
    /* no storage */
  }
});
