import type { ReactNode } from "react";
import clsx from "clsx";

/** The top of a team page: its title and a line saying what it is on the left, its main action (if any) on the right. */
export function PageHeader({ title, hint, action, className }: { title: ReactNode; hint?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={clsx("mb-6 flex items-start justify-between gap-3", className)}>
      <div className="min-w-0">
        <h1 className="text-xl font-semibold">{title}</h1>
        {hint && <p className="mt-1 text-sm text-muted">{hint}</p>}
      </div>
      {action}
    </div>
  );
}
