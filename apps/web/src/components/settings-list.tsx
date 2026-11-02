import type { ReactNode } from "react";
import clsx from "clsx";

/**
 * A settings section as a list: an optional title (and a line under it), then a card divided into rows, one setting each (see `SettingsRow`).
 * Anything else can sit in the list as a row of its own, padded as `SETTINGS_ROW_PAD`.
 */
export const SETTINGS_ROW_PAD = "px-6 py-4";

export function SettingsList({ title, hint, danger, label, children }: { title?: ReactNode; hint?: string; danger?: boolean; label?: string; children: ReactNode }) {
  return (
    <section className="space-y-2" aria-label={label ?? (typeof title === "string" ? title : undefined)}>
      <SettingsHeading title={title} hint={hint} danger={danger} />
      <div className={clsx("card divide-y divide-line", danger && "border-danger/40")}>{children}</div>
    </section>
  );
}

/** The title and line above a list; on its own, it heads several lists that belong together. */
export function SettingsHeading({ title, hint, danger }: { title?: ReactNode; hint?: string; danger?: boolean }) {
  if (!title && !hint) return null;
  return (
    <div className="space-y-0.5 px-1">
      {title && <h2 className={clsx("flex flex-wrap items-center gap-2 font-medium", danger && "text-danger")}>{title}</h2>}
      {hint && <p className="text-sm text-muted">{hint}</p>}
    </div>
  );
}

/** One setting: its name (and a line saying what it is) on the left, its value or control on the right. */
export function SettingsRow({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className={`flex flex-wrap items-center justify-between gap-x-6 gap-y-2 ${SETTINGS_ROW_PAD}`}>
      <div className="min-w-0">
        <div className="text-sm">{label}</div>
        {hint && <div className="text-xs text-muted">{hint}</div>}
      </div>
      <div className="min-w-0 text-sm text-muted">{children}</div>
    </div>
  );
}
