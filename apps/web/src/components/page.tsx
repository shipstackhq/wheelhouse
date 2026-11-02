import type { ReactNode } from "react";
import clsx from "clsx";

/**
 * A team page: it scrolls, its content has the app's padding, and it starts with a title, a line saying what the page is, and the
 * page's main action (if any) on the right. `className` shapes the content (spacing between its parts).
 */
export function Page({ title, hint, action, className, children }: { title: ReactNode; hint?: ReactNode; action?: ReactNode; className?: string; children: ReactNode }) {
  return (
    <div className="h-full overflow-y-auto bg-page">
      <div className={clsx("w-full px-4 py-8 sm:px-8 lg:py-12", className)}>
        <div className="mb-6 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-xl font-semibold">{title}</h1>
            {hint && <p className="mt-1 text-sm text-muted">{hint}</p>}
          </div>
          {action}
        </div>
        {children}
      </div>
    </div>
  );
}
