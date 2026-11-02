import type { ReactNode } from "react";

/**
 * A settings section as a list: an optional title, then a card divided into rows, one setting each (see `SettingsRow`).
 * Anything else can sit in the list as a row of its own, padded as `SETTINGS_ROW_PAD`.
 */
export const SETTINGS_ROW_PAD = "px-6 py-4";

export function SettingsList({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      {title && <h2 className="px-1 font-medium">{title}</h2>}
      <div className="card divide-y divide-line">{children}</div>
    </section>
  );
}

/** One setting: its name (and a line saying what it is) on the left, its value or control on the right. */
export function SettingsRow({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
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
