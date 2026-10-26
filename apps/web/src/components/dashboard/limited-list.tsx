import { Link } from "../../lib/workspace";
import { CollapsibleList } from "../collapsible-list";
import { Tip } from "../tip";

/** How many rows a section shows before the rest move behind "+N more". */
export const SECTION_LIMIT = 3;

/**
 * A row of two lines: an optional short lead and the title on top, muted who/when underneath. Anything longer than that
 * (full titles, file lists, authors) goes in the tooltip, which keyboard users reach by focusing the row.
 */
export function TwoLineRow({ lead, title, meta, href, tip }: { lead?: React.ReactNode; title: React.ReactNode; meta: React.ReactNode; href?: string; tip: React.ReactNode }) {
  // With a lead the title and meta line up in a second column; without one they simply start at the left.
  const body = lead ? (
    <span className="grid grid-cols-[2rem_minmax(0,1fr)] items-baseline gap-x-2">
      <span className="truncate text-xs text-muted">{lead}</span>
      <span className="truncate">{title}</span>
      <span />
      <span className="truncate text-xs text-muted">{meta}</span>
    </span>
  ) : (
    <span className="block">
      <span className="block truncate">{title}</span>
      <span className="block truncate text-xs text-muted">{meta}</span>
    </span>
  );
  // The list row (li) owns the padding; the link or focus area grows back over it so hover and focus cover the whole striped row.
  const cls = "-mx-[var(--list-px)] -my-[var(--list-py)] block px-[var(--list-px)] py-[var(--list-py)] outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent/60";
  return (
    <li>
      <Tip content={tip} align="start">
        {href ? (
          <Link to={href} className={`${cls} hover:bg-panel-2`}>
            {body}
          </Link>
        ) : (
          <div tabIndex={0} className={cls}>
            {body}
          </div>
        )}
      </Tip>
    </li>
  );
}

/** A titled list showing at most `limit` rows; "+N more" turns the whole list into a bounded, scrollable one. Renders nothing when empty. */
export function LimitedSection<T>({ title, items, row, limit = SECTION_LIMIT }: { title: string; items: T[]; row: (item: T) => React.ReactNode; limit?: number }) {
  if (!items.length) return null;
  return (
    <div>
      <div className="mb-1.5 text-xs font-medium text-muted">
        {title} <span className="font-normal text-muted/70">({items.length})</span>
      </div>
      <CollapsibleList limit={limit} title={title}>
        {items.map(row)}
      </CollapsibleList>
    </div>
  );
}
