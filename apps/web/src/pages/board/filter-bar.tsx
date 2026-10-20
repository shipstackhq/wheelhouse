import { useState } from "react";
import { Popover } from "radix-ui";
import { CloseIcon, FilterIcon, SearchIcon } from "../../components/icons";

/**
 * The board's filter row: a search box, a Filter button that picks labels, and the picked labels shown beside it as removable chips.
 * Dummy for now: it keeps the search text and the picked labels but does not yet narrow the issues on the board.
 */
export function BoardFilterBar(props: { labels: string[]; selected: string[]; onChange: (selected: string[]) => void }) {
  const { labels, selected, onChange } = props;
  const toggle = (l: string) => onChange(selected.includes(l) ? selected.filter((x) => x !== l) : [...selected, l]);
  const [query, setQuery] = useState("");
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative w-full min-w-48 max-w-xs sm:w-72">
        <input
          type="search"
          className="input !rounded-full !border-line !bg-panel-2 !py-1.5 !pl-9 text-sm focus:!border-accent"
          placeholder="Search issues"
          aria-label="Search issues"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <SearchIcon className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-base text-muted" />
      </div>
      <Popover.Root>
        <Popover.Trigger className="btn gap-1.5 !rounded-full py-1 text-xs data-[state=open]:border-muted/60 data-[state=open]:bg-panel-2" aria-label="Filter issues by label">
          <FilterIcon /> Filter
          {selected.length > 0 && <span className="tabular-nums text-accent">{selected.length}</span>}
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content align="start" sideOffset={6} collisionPadding={8} className="z-50 max-h-72 w-60 overflow-y-auto rounded-lg border border-line bg-panel p-2 text-sm text-fg shadow-xl">
            <div className="label px-1">Labels</div>
            {labels.length === 0 ? (
              <p className="px-1 py-2 text-xs text-muted">No labels on any issue yet.</p>
            ) : (
              labels.map((l) => (
                <label key={l} className="flex cursor-pointer items-center gap-2 rounded px-1 py-1.5 hover:bg-panel-2">
                  <input type="checkbox" checked={selected.includes(l)} onChange={() => toggle(l)} />
                  <span className="truncate">{l}</span>
                </label>
              ))
            )}
            {selected.length > 0 && (
              <button type="button" className="mt-1 w-full rounded px-1 py-1.5 text-left text-xs text-accent hover:bg-panel-2" onClick={() => onChange([])}>
                Clear filters
              </button>
            )}
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
      {selected.map((l) => (
        <span key={l} className="chip gap-1 !rounded-full bg-accent/15 py-1 pl-2 pr-1 text-accent" data-filter-chip>
          {l}
          <button type="button" className="rounded-full p-0.5 hover:bg-accent/20" aria-label={`Remove filter ${l}`} onClick={() => toggle(l)}>
            <CloseIcon />
          </button>
        </span>
      ))}
    </div>
  );
}
