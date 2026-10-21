import { Popover } from "radix-ui";
import clsx from "clsx";
import { ArrowDownIcon, ArrowUpIcon, CloseIcon, FilterIcon, SearchIcon } from "../../components/icons";
import {
  EMPTY_FILTERS,
  FILTER_KEYS,
  FILTER_LABEL,
  GROUP_BYS,
  GROUP_LABEL,
  SORT_KEYS,
  SORT_LABEL,
  filterCount,
  filterOptions,
  isFiltered,
  type FilterKey,
  type GroupContext,
  type IssueView,
} from "../../lib/issue-view";

const PANEL = "z-50 max-h-[26rem] overflow-y-auto rounded-lg border border-line bg-panel p-2 text-sm text-fg shadow-xl";
const TRIGGER = "btn gap-1.5 !rounded-full py-1 text-xs data-[state=open]:border-muted/60 data-[state=open]:bg-panel-2";
const ROW = "flex cursor-pointer items-center gap-2 rounded px-1 py-1.5 hover:bg-panel-2";

/**
 * The row above the issues: a search box, the Filter menu (what to keep, by status, priority, assignee, label, project and cycle), the
 * Display menu (what to group by, what to order by) and, under them, a chip for each thing kept that takes it off again. The view is one
 * object the page owns, so the list and the board narrow and order the same way.
 */
export function IssueViewBar(props: { view: IssueView; onChange: (v: IssueView) => void; ctx: GroupContext & { labels: string[] } }) {
  const { view, ctx } = props;
  const set = (patch: Partial<IssueView>) => props.onChange({ ...view, ...patch });
  const toggle = (key: FilterKey, value: string) => {
    const has = view.filters[key].includes(value);
    set({ filters: { ...view.filters, [key]: has ? view.filters[key].filter((x) => x !== value) : [...view.filters[key], value] } });
  };
  const clear = () => props.onChange({ ...view, filters: EMPTY_FILTERS, search: "" });
  const count = filterCount(view);
  const chips = FILTER_KEYS.flatMap((k) => {
    const options = filterOptions(k, ctx);
    return view.filters[k].map((value) => ({ key: k, value, label: options.find((o) => o.value === value)?.label ?? value }));
  });
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <div className="relative w-full min-w-48 max-w-xs sm:w-72">
        <input
          type="search"
          className="input !rounded-full !border-line !bg-panel-2 !py-1.5 !pl-9 text-sm focus:!border-accent"
          placeholder="Search issues"
          aria-label="Search issues"
          value={view.search}
          onChange={(e) => set({ search: e.target.value })}
        />
        <SearchIcon className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-base text-muted" />
      </div>

      <Popover.Root>
        <Popover.Trigger className={TRIGGER} aria-label="Filter issues">
          <FilterIcon /> Filter
          {count > 0 && <span className="tabular-nums text-accent">{count}</span>}
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content align="start" sideOffset={6} collisionPadding={8} className={clsx(PANEL, "w-64")}>
            {FILTER_KEYS.map((k) => {
              const options = filterOptions(k, ctx);
              return (
                <fieldset key={k} className="mb-1" aria-label={FILTER_LABEL[k]}>
                  <legend className="label px-1">{FILTER_LABEL[k]}</legend>
                  {k === "label" && options.length === 0 ? (
                    <p className="px-1 py-1 text-xs text-muted">No labels on any issue yet.</p>
                  ) : (
                    options.map((o) => (
                      <label key={o.value} className={ROW}>
                        <input type="checkbox" checked={view.filters[k].includes(o.value)} onChange={() => toggle(k, o.value)} />
                        <span className="truncate">{o.label}</span>
                      </label>
                    ))
                  )}
                </fieldset>
              );
            })}
            {isFiltered(view) && (
              <button type="button" className="mt-1 w-full rounded px-1 py-1.5 text-left text-xs text-accent hover:bg-panel-2" onClick={() => clear()}>
                Clear filters
              </button>
            )}
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>

      <Popover.Root>
        <Popover.Trigger className={TRIGGER} aria-label="Display options">
          Display
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content align="start" sideOffset={6} collisionPadding={8} className={clsx(PANEL, "w-60")}>
            <fieldset aria-label="Grouping" className="mb-2">
              <legend className="label px-1">Grouping</legend>
              {GROUP_BYS.map((g) => (
                <label key={g} className={ROW}>
                  <input type="radio" name="group-by" checked={view.groupBy === g} onChange={() => set({ groupBy: g })} />
                  {GROUP_LABEL[g]}
                </label>
              ))}
            </fieldset>
            <div>
              <label className="label px-1" htmlFor="order-by">Ordering</label>
              <div className="flex items-center gap-1">
                <select id="order-by" className="input flex-1 py-1.5 text-sm" value={view.sort.key} onChange={(e) => set({ sort: { ...view.sort, key: e.target.value as IssueView["sort"]["key"] } })}>
                  {SORT_KEYS.map((k) => (
                    <option key={k} value={k}>{SORT_LABEL[k]}</option>
                  ))}
                </select>
                <button
                  type="button"
                  className="btn px-2 py-1.5"
                  disabled={view.sort.key === "manual"}
                  aria-label={view.sort.dir === "asc" ? "Ascending: switch to descending" : "Descending: switch to ascending"}
                  onClick={() => set({ sort: { ...view.sort, dir: view.sort.dir === "asc" ? "desc" : "asc" } })}
                >
                  {view.sort.dir === "asc" ? <ArrowUpIcon aria-hidden /> : <ArrowDownIcon aria-hidden />}
                </button>
              </div>
            </div>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>

      {chips.map((c) => (
        <span key={`${c.key}:${c.value}`} className="chip gap-1 !rounded-full bg-accent/15 py-1 pl-2 pr-1 text-accent" data-filter-chip>
          <span className="text-accent/70">{FILTER_LABEL[c.key]}:</span> {c.label}
          <button type="button" className="rounded-full p-0.5 hover:bg-accent/20" aria-label={`Remove filter ${FILTER_LABEL[c.key]}: ${c.label}`} onClick={() => toggle(c.key, c.value)}>
            <CloseIcon />
          </button>
        </span>
      ))}
      {isFiltered(view) && (
        <button type="button" className="text-xs text-muted hover:text-fg" onClick={() => clear()}>
          Clear
        </button>
      )}
    </div>
  );
}
