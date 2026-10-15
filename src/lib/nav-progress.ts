/** Pure rules for the top progress bar, so they can be tested without a browser. */

export const PROGRESS_START = 8;
export const PROGRESS_CEILING = 90;
/** A navigation that never changes the address (same link twice, a download) must not leave the bar running. */
export const PROGRESS_TIMEOUT_MS = 10_000;

/** Each tick moves a tenth of the way to the ceiling: quick at first, then it waits for the page instead of finishing early. */
export function nextProgress(p: number): number {
  return Math.min(PROGRESS_CEILING, p + (PROGRESS_CEILING - p) * 0.1);
}

type ClickInfo = {
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  defaultPrevented: boolean;
  /** The anchor that was clicked, if any. */
  anchor: { href: string; target: string; hasDownload: boolean } | null;
};

/** Does this click start an in-app navigation (so the bar should run)? `current` is the page's own URL. */
export function startsNavigation(c: ClickInfo, current: string): boolean {
  if (c.defaultPrevented || c.button !== 0 || c.metaKey || c.ctrlKey || c.shiftKey || c.altKey) return false;
  if (!c.anchor || c.anchor.hasDownload || (c.anchor.target && c.anchor.target !== "_self")) return false;
  let to: URL, here: URL;
  try {
    to = new URL(c.anchor.href);
    here = new URL(current);
  } catch {
    return false;
  }
  if (to.origin !== here.origin) return false;
  // Same page, same query: nothing will change. A different hash on the same page is not a navigation either.
  return to.pathname !== here.pathname || to.search !== here.search;
}
