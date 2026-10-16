import clsx from "clsx";

/** A pulsing placeholder block (steady when the user prefers reduced motion). */
export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={clsx("rounded-md bg-panel-2 motion-safe:animate-pulse", className)} />;
}

/**
 * What a page looks like while its data loads: a title, a toolbar and rows. Announced once as busy, not block by block.
 * `inset` leaves room for the page padding that real pages have.
 */
export function PageSkeleton({ label = "Loading", rows = 6, inset = true }: { label?: string; rows?: number; inset?: boolean }) {
  return (
    <div role="status" aria-busy="true" aria-live="polite" className={clsx("h-full overflow-hidden", inset && "px-6 py-8")}>
      <span className="sr-only">{label}…</span>
      <Skeleton className="h-6 w-56" />
      <Skeleton className="mt-3 h-4 w-96 max-w-full" />
      <div className="mt-8 space-y-3">
        {Array.from({ length: rows }, (_, i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
    </div>
  );
}
