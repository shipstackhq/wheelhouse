import { useEffect, useState } from "react";
import { useNavigation } from "react-router";
import { Spinner } from "./spinner";

/** How long a navigation has to take before a spinner appears, so instant ones do not flicker. */
export const LINK_SPINNER_DELAY_MS = 150;

/**
 * Put inside a link: shows a spinner while that link's navigation is pending and slow. `pending` says whether it is
 * (see useLinkPending); with no router around, as in a static render, it simply shows nothing.
 */
export function LinkPending({ pending = false, className }: { pending?: boolean; className?: string }) {
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (!pending) {
      setShow(false);
      return;
    }
    const id = setTimeout(() => setShow(true), LINK_SPINNER_DELAY_MS);
    return () => clearTimeout(id);
  }, [pending]);
  return show ? <Spinner className={className ?? "h-3 w-3"} /> : null;
}

/** Is the navigation to this address in flight right now? */
export function useLinkPending(href: string): boolean {
  const nav = useNavigation();
  return nav.state !== "idle" && !!nav.location && nav.location.pathname === href.split(/[?#]/)[0];
}
