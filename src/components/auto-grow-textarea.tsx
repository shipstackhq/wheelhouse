"use client";

import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import clsx from "clsx";

/**
 * A textarea that is always exactly as tall as its text: long values wrap onto more lines instead of
 * scrolling sideways or being cut off. It re-fits when the text changes and when its width changes.
 */
export function AutoGrowTextarea({ className, onInput, ...rest }: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const fit = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, []);

  useLayoutEffect(fit, [fit, rest.value]);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let width = el.clientWidth;
    const watch = new ResizeObserver(() => {
      if (el.clientWidth === width) return; // our own height change fires this too
      width = el.clientWidth;
      fit();
    });
    watch.observe(el);
    return () => watch.disconnect();
  }, [fit]);

  return (
    <textarea
      rows={1}
      {...rest}
      ref={ref}
      onInput={(e) => {
        fit();
        onInput?.(e);
      }}
      className={clsx("block w-full resize-none overflow-hidden whitespace-pre-wrap break-words", className)}
    />
  );
}
