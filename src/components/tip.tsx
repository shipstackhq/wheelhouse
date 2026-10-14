"use client";

import { Tooltip } from "radix-ui";

/**
 * Hover/focus tooltip for details that don't earn permanent screen space.
 * `children` must be a single element that can hold a ref (the trigger); it should be focusable
 * (or contain something focusable) so keyboard users can reach the details too.
 */
export function Tip({ content, children, side = "top", align = "start" }: { content: React.ReactNode; children: React.ReactElement; side?: "top" | "bottom" | "left" | "right"; align?: "start" | "center" | "end" }) {
  return (
    <Tooltip.Provider delayDuration={250} skipDelayDuration={150}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content
            side={side}
            align={align}
            sideOffset={6}
            collisionPadding={8}
            className="z-[60] max-w-72 rounded-md border border-line bg-panel px-2.5 py-1.5 text-xs text-fg shadow-xl"
          >
            {content}
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}
