import { Popover } from "radix-ui";
import clsx from "clsx";
import { ArrowDownIcon, ArrowUpIcon, BoardIcon, BulletListIcon, CloseIcon, DisplayIcon, FilterIcon, SearchIcon, SheetIcon } from "../../components/icons";
import { Select } from "../../components/ui";
import { LAYOUTS, type Layout } from "../../lib/issue-layout";
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
  DEFAULT_VIEW,
} from "../../lib/issue-view";

const PANEL = "z-50 max-h-[26rem] overflow-y-auto rounded-lg border border-line bg-panel text-sm text-fg shadow-xl";
const TRIGGER = "btn h-[34px] gap-1.5 !rounded-full !border-transparent !bg-card py-0 text-xs data-[state=open]:!border-transparent data-[state=open]:!bg-card";
const ROW = "flex cursor-pointer items-center gap-2 rounded px-1 py-1.5 hover:bg-panel-2";

/**
 * The row above the issues: a search box, the Filter menu (what to keep, by status, priority, assignee, label, project and cycle), the
 * Display menu (what to group by, what to order by) and, under them, a chip for each thing kept that takes it off again. The view is one
 * object the page owns, so the list and the board narrow and order the same way.
 */
/** One row of the Display menu: an icon and a label on the left, the control on the right. */
function DisplayRow({ icon, label, disabled, children }: { icon?: React.ReactNode; label: string; disabled?: boolean; children: React.ReactNode }) {
  return (
    <div className={clsx("flex min-h-7 items-center justify-between gap-3 px-0 text-xs", disabled && "opacity-50")}>
      <span className="flex min-w-0 items-center gap-2 text-muted">
        {icon}
        <span className="truncate">{label}</span>
      </span>
      {children}
    </div>
  );
}

/** A switch: a button that says on or off, not a checkbox. */
function Switch({ label, checked, disabled, onChange }: { label: string; checked: boolean; disabled?: boolean; onChange: (checked: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-label={label}
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={clsx("relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors outline-none focus-visible:ring-2 focus-visible:ring-accent/50 disabled:cursor-not-allowed", checked ? "bg-accent" : "bg-panel-2 border border-line")}
    >
      <span className={clsx("inline-block h-4 w-4 rounded-full bg-white shadow transition-transform", checked ? "translate-x-[18px]" : "translate-x-0.5")} />
    </button>
  );
}

export function IssueViewBar(props: { view: IssueView; onChange: (v: IssueView) => void; ctx: GroupContext & { labels: string[] }; layout: Layout; onLayout: (l: Layout) => void; sheetOpen: boolean; onToggleSheet: () => void }) {
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
    <div className="flex w-full min-w-0 flex-wrap items-center gap-2">
      <div className="relative w-full min-w-48 max-w-xs sm:w-72">
        <input
          type="search"
          className="input !h-[34px] !rounded-full !border-transparent !bg-card !py-0 !pl-9 text-sm focus:!border-transparent"
          placeholder="Search issues"
          aria-label="Search issues"
          value={view.search}
          onChange={(e) => set({ search: e.target.value })}
        />
        <SearchIcon className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-base text-muted" />
      </div>

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
      <div className="ml-auto flex items-center gap-2">
      <Popover.Root>
        <Popover.Trigger className={clsx(TRIGGER, "!w-[34px] !px-0 justify-center")} aria-label="Filter issues" title="Filter">
          <FilterIcon />
          {count > 0 && <span className="tabular-nums text-accent">{count}</span>}
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content align="start" sideOffset={6} collisionPadding={8} className={clsx(PANEL, "w-64 p-2")}>
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
        <Popover.Trigger className={clsx(TRIGGER, "!w-[34px] !px-0 justify-center")} aria-label="Display options" title="Display">
          <DisplayIcon />
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content align="start" sideOffset={6} collisionPadding={8} className={clsx(PANEL, "w-72 !text-xs")}>
            <div className="px-2 py-2">
              <div role="group" aria-label="Layout" className="grid grid-cols-2 gap-1 rounded-full border border-line bg-bg p-1">
                {LAYOUTS.map((l) => (
                  <button
                    key={l}
                    type="button"
                    aria-pressed={props.layout === l}
                    onClick={() => props.onLayout(l)}
                    className={clsx(
                      "inline-flex h-7 items-center justify-center gap-2 rounded-full px-3 text-center text-xs capitalize outline-none focus-visible:ring-2 focus-visible:ring-accent/50",
                      props.layout === l ? "bg-card text-fg shadow-sm" : "text-muted hover:text-fg",
                    )}
                  >
                    {l === "list" ? <BulletListIcon aria-hidden /> : <BoardIcon aria-hidden />}
                    {l === "list" ? "List" : "Board"}
                  </button>
                ))}
              </div>
            </div>
            <div className="space-y-0 border-t border-line px-2 py-2">
              <DisplayRow label="Grouping">
                <Select
                  ariaLabel="Grouping"
                  noChevron
                  compact
                  className="!w-28"
                  triggerClassName="!py-0.5 !px-2.5 text-xs"
                  value={view.groupBy}
                  options={GROUP_BYS.map((g) => ({ value: g, label: GROUP_LABEL[g] }))}
                  onValueChange={(v) => set({ groupBy: v as IssueView["groupBy"] })}
                />
              </DisplayRow>
              <DisplayRow
                label="Ordering"
              >
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    className="rounded px-1 py-0.5 text-muted outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-accent/50 disabled:opacity-40"
                    disabled={view.sort.key === "manual"}
                    aria-label={view.sort.dir === "asc" ? "Ascending: switch to descending" : "Descending: switch to ascending"}
                    onClick={() => set({ sort: { ...view.sort, dir: view.sort.dir === "asc" ? "desc" : "asc" } })}
                  >
                    {view.sort.dir === "asc" ? <ArrowUpIcon aria-hidden /> : <ArrowDownIcon aria-hidden />}
                  </button>
                  <Select
                    ariaLabel="Ordering"
                    noChevron
                    compact
                    className="!w-28"
                    triggerClassName="!py-0.5 !px-2.5 text-xs"
                    value={view.sort.key}
                    options={SORT_KEYS.map((k) => ({ value: k, label: SORT_LABEL[k] }))}
                    onValueChange={(v) => set({ sort: { ...view.sort, key: v as IssueView["sort"]["key"] } })}
                  />
                </div>
              </DisplayRow>
            </div>
            <div className="space-y-1 border-t border-line px-2 py-2">
              <DisplayRow label="Show sub-issues">
                <Switch label="Show sub-issues" checked={view.showSub} onChange={(checked) => set({ showSub: checked })} />
              </DisplayRow>
            </div>
            <div className="border-t border-line px-2 py-2">
              <p className="px-1 pb-1 text-xs font-medium">List options</p>
              <div className="space-y-1">
                <DisplayRow label="Nest sub-issues under their parent" disabled={!view.showSub}>
                  <Switch label="Nest sub-issues under their parent" checked={view.nest} disabled={!view.showSub} onChange={(checked) => set({ nest: checked })} />
                </DisplayRow>
              </div>
            </div>
            <div className="border-t border-line px-2 py-2 text-xs">
              <button type="button" className="w-full rounded-md px-3 py-1.5 text-left text-fg outline-none hover:bg-panel-2 focus-visible:ring-2 focus-visible:ring-accent/50" onClick={() => props.onChange({ ...view, groupBy: DEFAULT_VIEW.groupBy, sort: DEFAULT_VIEW.sort, showSub: DEFAULT_VIEW.showSub, nest: DEFAULT_VIEW.nest })}>
                Reset
              </button>
            </div>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
      <button
        type="button"
        onClick={props.onToggleSheet}
        aria-expanded={props.sheetOpen}
        aria-controls="issues-sheet"
        aria-label={props.sheetOpen ? "Close the side sheet" : "Open the side sheet"}
        title="Side sheet"
        className={clsx(TRIGGER, "!w-[34px] !px-0 justify-center")}
      >
        <SheetIcon />
      </button>
      </div>
    </div>
  );
}
