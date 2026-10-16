import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigation } from "react-router";
import { nextProgress, PROGRESS_START, PROGRESS_TIMEOUT_MS, startsNavigation } from "../lib/nav-progress";

/** Broadcast this to run the bar for a navigation that does not start from a link (router.push / router.replace). */
export const NAVIGATION_START_EVENT = "wheelhouse:navigation-start";

/**
 * A thin bar along the top while an in-app navigation is pending. An installed PWA has no browser tab spinner, so without
 * this a slow page looks like a dead click. It starts on a link click, back/forward, NAVIGATION_START_EVENT or the router
 * starting a navigation, and finishes when the address changes.
 */
export function NavigationProgress() {
  const { pathname: path, search } = useLocation();
  const navigation = useNavigation();
  const [progress, setProgress] = useState<number | null>(null); // null: hidden
  const ticker = useRef<ReturnType<typeof setInterval> | null>(null);
  const cap = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fade = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimers = () => {
    if (ticker.current) clearInterval(ticker.current);
    if (cap.current) clearTimeout(cap.current);
    ticker.current = cap.current = null;
  };
  const finish = () => {
    clearTimers();
    setProgress((p) => (p === null ? null : 100));
    if (fade.current) clearTimeout(fade.current);
    fade.current = setTimeout(() => setProgress(null), 200);
  };
  const start = () => {
    if (fade.current) clearTimeout(fade.current);
    clearTimers();
    setProgress(PROGRESS_START);
    ticker.current = setInterval(() => setProgress((p) => (p === null ? p : nextProgress(p))), 250);
    cap.current = setTimeout(finish, PROGRESS_TIMEOUT_MS);
  };

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      const info = {
        button: e.button,
        metaKey: e.metaKey,
        ctrlKey: e.ctrlKey,
        shiftKey: e.shiftKey,
        altKey: e.altKey,
        defaultPrevented: e.defaultPrevented,
        anchor: a ? { href: a.href, target: a.target, hasDownload: a.hasAttribute("download") } : null,
      };
      // The router handles the click after this listener (it calls preventDefault), so decide on the click as it arrived.
      if (startsNavigation({ ...info, defaultPrevented: false }, window.location.href)) start();
    };
    document.addEventListener("click", onClick, true);
    window.addEventListener("popstate", start);
    window.addEventListener(NAVIGATION_START_EVENT, start);
    return () => {
      document.removeEventListener("click", onClick, true);
      window.removeEventListener("popstate", start);
      window.removeEventListener(NAVIGATION_START_EVENT, start);
      clearTimers();
      if (fade.current) clearTimeout(fade.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A navigation the router is running (a loader, navigate()) that did not start from a link click.
  useEffect(() => {
    if (navigation.state !== "idle") start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navigation.state]);

  // The address changed: the navigation landed.
  useEffect(() => {
    finish();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, search]);

  if (progress === null) return null;
  return (
    <div role="progressbar" aria-label="Loading page" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress)} className="pointer-events-none fixed inset-x-0 top-0 z-[100] h-0.5">
      <div className="h-full bg-accent transition-[width,opacity] duration-200 ease-out motion-reduce:transition-none" style={{ width: `${progress}%`, opacity: progress >= 100 ? 0 : 1 }} />
    </div>
  );
}
