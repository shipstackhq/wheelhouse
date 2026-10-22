import clsx from "clsx";

/** What a priority is called on screen. */
export const PRIORITY_LABEL: Record<string, string> = { none: "No priority", urgent: "Urgent", high: "High", medium: "Medium", low: "Low" };

/** The priorities in the order a menu lists them: most pressing first, "none" last. */
export const PRIORITY_ORDER = ["urgent", "high", "medium", "low", "none"] as const;

const BARS: Record<string, number> = { low: 1, medium: 2, high: 3 };

/**
 * A priority as an icon: three bars filled up to the level (low one, medium two, high three), an alert square for urgent and three dashes
 * for no priority. Decorative: the label is always beside it or on its button.
 */
export function PriorityIcon({ priority, className }: { priority: string; className?: string }) {
  if (priority === "urgent") {
    return (
      <svg aria-hidden viewBox="0 0 14 14" className={clsx("size-3.5 shrink-0 text-danger", className)} data-priority="urgent">
        <rect x="1" y="1" width="12" height="12" rx="3" fill="currentColor" />
        <path d="M7 4v3.6M7 9.8v.01" fill="none" stroke="white" strokeWidth="1.7" strokeLinecap="round" />
      </svg>
    );
  }
  const filled = BARS[priority] ?? 0;
  return (
    <svg aria-hidden viewBox="0 0 14 14" className={clsx("size-3.5 shrink-0", filled ? "text-fg" : "text-muted", className)} data-priority={priority}>
      {filled === 0 ? (
        <path d="M2 7h2.2M5.9 7h2.2M9.8 7h2.2" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      ) : (
        [0, 1, 2].map((i) => <rect key={i} x={1.5 + i * 4.2} y={9 - i * 3} width="2.6" height={3 + i * 3} rx="0.8" fill="currentColor" opacity={i < filled ? 1 : 0.25} />)
      )}
    </svg>
  );
}
