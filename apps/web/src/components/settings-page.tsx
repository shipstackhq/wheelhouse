import type { ReactNode } from "react";

/** One settings page: its title, a line saying what it is, the page's main action (if any) on the right, then its lists. */
export function SettingsPage({ title, hint, action, children }: { title: ReactNode; hint: string; action?: ReactNode; children: ReactNode }) {
  return (
    <div className="w-full space-y-4 px-4 py-8 sm:px-8 lg:py-12">
      <div className="flex items-start justify-between gap-4 pb-2">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold">{title}</h1>
          <p className="mt-1 text-sm text-muted">{hint}</p>
        </div>
        {action}
      </div>
      {children}
    </div>
  );
}
