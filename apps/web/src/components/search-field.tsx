import clsx from "clsx";
import { SearchIcon } from "./icons";

/** The search box of a list page: a rounded field with the magnifier at its left. `label` is what a screen reader hears. */
export function SearchField({ value, onChange, placeholder, label, onEscape, className }: { value: string; onChange: (value: string) => void; placeholder: string; label: string; onEscape?: () => void; className?: string }) {
  return (
    <div className={clsx("relative mb-4", className)}>
      <SearchIcon className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-base text-muted" />
      <input
        type="search"
        className="input !rounded-full !border-transparent !bg-panel-2/70 !py-2.5 !pl-10 text-sm focus:!border-accent"
        placeholder={placeholder}
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onEscape && ((e) => e.key === "Escape" && onEscape())}
      />
    </div>
  );
}
