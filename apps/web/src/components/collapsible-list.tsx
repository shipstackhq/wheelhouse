import { Children, useId, useState } from "react";
import { List, type ListDensity, type ListInset } from "./list";

/**
 * A list that shows its first `limit` rows and a "+N more" button. Expanded, the WHOLE list becomes one scrollable
 * list of bounded height (so a long list never stretches its card) with "show less" pinned at the bottom of the
 * scroll area, always visible however far you've scrolled.
 */
export function CollapsibleList({
  limit,
  title,
  children,
  defaultOpen = false,
  density = "compact",
  inset = "card",
}: {
  limit: number;
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
  density?: ListDensity;
  inset?: ListInset;
}) {
  const rows = Children.toArray(children);
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  const extra = rows.length - limit;

  if (extra <= 0)
    return (
      <List density={density} inset={inset} className="text-sm">
        {rows}
      </List>
    );
  const btn = "rounded text-xs text-muted underline-offset-2 hover:text-fg hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/60";

  if (!open)
    return (
      <>
        <List id={id} density={density} inset={inset} className="text-sm">
          {rows.slice(0, limit)}
        </List>
        <button type="button" aria-expanded={false} aria-controls={id} onClick={() => setOpen(true)} className={`mt-1.5 ${btn}`}>
          +{extra} more
        </button>
      </>
    );

  return (
    <List id={id} density={density} inset={inset} aria-label={`${title}, all ${rows.length}`} className="max-h-56 overflow-y-auto overflow-x-hidden overscroll-contain text-sm">
      {rows}
      <li data-plain className="sticky bottom-0 border-t border-line/60 bg-panel">
        <button type="button" aria-expanded aria-controls={id} onClick={() => setOpen(false)} className={btn}>
          show less
        </button>
      </li>
    </List>
  );
}
