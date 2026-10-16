import clsx from "clsx";

/** Vertical padding of each row: compact (dense rows), normal, roomy (rows with several lines of their own). */
export type ListDensity = "compact" | "normal" | "roomy";
/**
 * Where the list sits:
 * - "none": inside its parent's padding (rows get their own small side padding)
 * - "card": stripes run edge to edge of a padded card (the list cancels the card's 1rem padding)
 * - "flush": the list already touches its container's edges (popovers, menus), rows keep 1rem side padding
 */
export type ListInset = "none" | "flush" | "card";

/**
 * The list every surface uses: rows alternate light/dark, padding comes from `density`.
 * Children are plain `<li>`; a row that must not be striped (a sticky footer, say) adds `data-plain`.
 * The styling lives in globals.css under `.list`, driven by the data attributes below.
 */
export function List({
  density = "normal",
  inset = "none",
  ordered = false,
  className,
  children,
  ...rest
}: { density?: ListDensity; inset?: ListInset; ordered?: boolean } & React.HTMLAttributes<HTMLUListElement | HTMLOListElement>) {
  const Tag = ordered ? "ol" : "ul";
  return (
    <Tag {...rest} data-density={density} data-inset={inset} className={clsx("list", className)}>
      {children}
    </Tag>
  );
}
