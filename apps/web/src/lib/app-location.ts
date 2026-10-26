import { useEffect } from "react";
import { useLocation } from "react-router";

/**
 * Where the person was in the app, so Settings (its own screen, with its own sidebar) can send them back to it. Anything under
 * /settings (or /w/:slug/settings) is not remembered. Kept in memory, and in sessionStorage so a reload on the settings screen still knows.
 */
const KEY = "wh:app-location";
let last: string | null = null;

const isSettings = (path: string) => /^(\/w\/[^/]+)?\/settings(\/|$)/.test(path);

export function rememberAppLocation(path: string) {
  if (isSettings(path)) return;
  last = path;
  try {
    sessionStorage.setItem(KEY, path);
  } catch {
    /* the memory still works for this tab's lifetime */
  }
}

/** Forget everything (sign-out, and tests). */
export function forgetAppLocation() {
  last = null;
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    /* nothing stored */
  }
}

/** The page to go back to; the home page when nothing is known. */
export function lastAppLocation(): string {
  if (last) return last;
  try {
    const stored = sessionStorage.getItem(KEY);
    if (stored && stored.startsWith("/") && !isSettings(stored)) return stored;
  } catch {
    /* fall through */
  }
  return "/";
}

/** In the app shell: note every page the person visits. */
export function useRememberAppLocation() {
  const { pathname, search } = useLocation();
  useEffect(() => rememberAppLocation(pathname + search), [pathname, search]);
}
