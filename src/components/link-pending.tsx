"use client";

import { useEffect, useState } from "react";
import { useLinkStatus } from "next/link";
import { Spinner } from "./spinner";

/** How long a navigation has to take before a spinner appears, so instant ones do not flicker. */
export const LINK_SPINNER_DELAY_MS = 150;

/** Put inside a `<Link>`: shows a spinner on that link while its navigation is pending and slow. */
export function LinkPending({ className }: { className?: string }) {
  const { pending } = useLinkStatus();
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
