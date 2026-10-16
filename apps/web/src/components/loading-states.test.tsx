import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import assert from "node:assert/strict";
import { act, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { Spinner } from "./spinner";
import { Skeleton, PageSkeleton } from "./skeleton";
import { LinkPending, LINK_SPINNER_DELAY_MS } from "./link-pending";

// The first four are the Next app's tests of these components, with the assertions unchanged.

test("the spinner is decorative and stands still for people who ask for less motion", () => {
  const html = renderToStaticMarkup(<Spinner />);
  assert.ok(html.includes('aria-hidden="true"'));
  assert.ok(html.includes("motion-safe:animate-spin"), "it only spins when motion is allowed");
});

test("a skeleton block is hidden from screen readers and only pulses when motion is allowed", () => {
  const html = renderToStaticMarkup(<Skeleton className="h-4" />);
  assert.ok(html.includes('aria-hidden="true"') && html.includes("motion-safe:animate-pulse") && html.includes("h-4"));
});

test("a page skeleton is announced once as busy, with a label, not block by block", () => {
  const html = renderToStaticMarkup(<PageSkeleton label="Loading the board" rows={3} />);
  assert.ok(html.includes('role="status"') && html.includes('aria-busy="true"'));
  assert.ok(html.includes("Loading the board…") && html.includes("sr-only"));
  assert.equal((html.match(/h-12/g) ?? []).length, 3, "one placeholder per row asked for");
});

test("a link shows no spinner until its navigation is pending, and then only after a short delay", () => {
  assert.equal(renderToStaticMarkup(<LinkPending />), "");
  assert.ok(LINK_SPINNER_DELAY_MS >= 100 && LINK_SPINNER_DELAY_MS <= 300, "long enough not to flicker, short enough to feel immediate");
});

// And the behaviour that test only described.

describe("the spinner on a link", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test("appears only after the delay, and goes as soon as the navigation ends", () => {
    const { container, rerender } = render(<LinkPending pending />);
    expect(container.querySelector("svg")).toBeNull();
    act(() => void vi.advanceTimersByTime(LINK_SPINNER_DELAY_MS - 1));
    expect(container.querySelector("svg")).toBeNull();
    act(() => void vi.advanceTimersByTime(2));
    expect(container.querySelector("svg")).not.toBeNull();
    rerender(<LinkPending pending={false} />);
    expect(container.querySelector("svg")).toBeNull();
  });

  test("a navigation that finishes inside the delay never shows it", () => {
    const { container, rerender } = render(<LinkPending pending />);
    act(() => void vi.advanceTimersByTime(LINK_SPINNER_DELAY_MS - 20));
    rerender(<LinkPending pending={false} />);
    act(() => void vi.advanceTimersByTime(1000));
    expect(container.querySelector("svg")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });
});
