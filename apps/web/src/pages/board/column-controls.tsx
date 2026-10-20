import { DropdownMenu } from "radix-ui";
import clsx from "clsx";
import type { BoardMember as Member, BoardTicket, CycleOption } from "@wheelhouse/api-client";
import { CheckIcon, CloseIcon } from "../../components/icons";

type Ticket = BoardTicket;

export type Flag = "aiReady" | "claimed" | "byAgent" | "linked" | "hasComments";
export type SortKey = "priority" | "created" | "updated" | "title" | "number" | "comments";
export type View = {
  priority: string[];
  assignee: string[]; // member ids, or "none" for unassigned
  label: string[];
  cycle: string[]; // cycle numbers as text, or "none" for tickets in no cycle
  flags: Flag[];
  sort: { key: SortKey; dir: "asc" | "desc" } | null; // null = manual (drag order)
};

export const EMPTY_VIEW: View = { priority: [], assignee: [], label: [], cycle: [], flags: [], sort: null };

const PRIORITIES = ["urgent", "high", "medium", "low"];
const PRIORITY_RANK: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3 };

const FLAGS: { value: Flag; label: string }[] = [
  { value: "aiReady", label: "AI-ready" },
  { value: "claimed", label: "Claimed by an agent" },
  { value: "byAgent", label: "Created by an agent" },
  { value: "linked", label: "Linked to a map node" },
  { value: "hasComments", label: "Has comments" },
];

const SORTS: { value: SortKey; label: string }[] = [
  { value: "priority", label: "Priority" },
  { value: "created", label: "Created" },
  { value: "updated", label: "Last updated" },
  { value: "title", label: "Title" },
  { value: "number", label: "Number" },
  { value: "comments", label: "Comment count" },
];

const FLAG_TEST: Record<Flag, (t: Ticket) => boolean> = {
  aiReady: (t) => t.agentClaimable,
  claimed: (t) => !!t.claimedByKeyId,
  byAgent: (t) => t.createdByKind === "agent",
  linked: (t) => t.nodeIds.length > 0,
  hasComments: (t) => t.commentCount > 0,
};

export const isFiltered = (v: View) => v.priority.length + v.assignee.length + v.label.length + v.cycle.length + v.flags.length > 0;
/** Each of priority/assignee/label/cycle is one filter; every flag is its own. */
const filterCount = (v: View) => [v.priority, v.assignee, v.label, v.cycle].filter((g) => g.length > 0).length + v.flags.length;

/** Filters combine with AND; several values inside one filter combine with OR. */
export function matches(t: Ticket, v: View) {
  if (v.priority.length && !v.priority.includes(t.priority)) return false;
  if (v.assignee.length && !v.assignee.includes(t.assigneeId ?? "none")) return false;
  if (v.label.length && !t.labels.some((l) => v.label.includes(l))) return false;
  if (v.cycle.length && !v.cycle.includes(t.cycle == null ? "none" : String(t.cycle))) return false;
  return v.flags.every((f) => FLAG_TEST[f](t));
}

export function applyView(tickets: Ticket[], v: View, alwaysShow?: (t: Ticket) => boolean): Ticket[] {
  let out = isFiltered(v) ? tickets.filter((t) => matches(t, v) || alwaysShow?.(t)) : tickets;
  if (v.sort) {
    const { key, dir } = v.sort;
    const val = (t: Ticket): number | string => {
      switch (key) {
        case "priority": return PRIORITY_RANK[t.priority] ?? 9;
        case "created": return new Date(t.createdAt).getTime();
        case "updated": return new Date(t.updatedAt).getTime();
        case "title": return t.title.toLowerCase();
        case "number": return t.number;
        case "comments": return t.commentCount;
      }
    };
    const sign = dir === "asc" ? 1 : -1;
    out = [...out].sort((a, b) => {
      const x = val(a), y = val(b);
      return (x < y ? -1 : x > y ? 1 : 0) * sign || a.number - b.number;
    });
  }
  return out;
}

export function describeFilter(v: View, members: Member[]) {
  if (filterCount(v) > 1) return `${filterCount(v)} applied`;
  if (v.priority.length) return v.priority.length === 1 ? `${cap(v.priority[0])} priority` : `${v.priority.length} priorities`;
  if (v.assignee.length)
    return v.assignee.length === 1 ? (v.assignee[0] === "none" ? "Unassigned" : (members.find((m) => m.id === v.assignee[0])?.name ?? "Assignee")) : `${v.assignee.length} assignees`;
  if (v.label.length) return v.label.length === 1 ? v.label[0] : `${v.label.length} labels`;
  if (v.cycle.length) return v.cycle.length === 1 ? (v.cycle[0] === "none" ? "No cycle" : `Cycle ${v.cycle[0]}`) : `${v.cycle.length} cycles`;
  return FLAGS.find((f) => f.value === v.flags[0])?.label ?? "";
}

export function describeSort(v: View) {
  if (!v.sort) return "";
  return `${SORTS.find((s) => s.value === v.sort!.key)?.label} ${v.sort.dir === "asc" ? "↑" : "↓"}`;
}

const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

export function loadView(storageKey: string): View {
  try {
    const raw = localStorage.getItem(storageKey);
    if (raw) return { ...EMPTY_VIEW, ...JSON.parse(raw) };
  } catch {}
  return EMPTY_VIEW;
}

export function saveView(storageKey: string, v: View) {
  try {
    if (isFiltered(v) || v.sort) localStorage.setItem(storageKey, JSON.stringify(v));
    else localStorage.removeItem(storageKey);
  } catch {}
}

const MENU = "z-50 min-w-52 rounded-lg border border-line bg-panel p-1 text-sm text-fg shadow-xl";
const ITEM = "flex cursor-pointer select-none items-center gap-2 rounded px-2 py-1.5 outline-none data-[highlighted]:bg-panel-2";
const HEAD = "px-2 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wide text-muted";

/** Trigger that is hover/focus-only while inactive and stays put, with its label and a clear button, while active. */
function Trigger({ active, label, name, onClear }: { active: boolean; label: string; name: string; onClear: () => void }) {
  return (
    <span className={clsx("inline-flex items-center", !active && "opacity-0 transition-opacity group-focus-within/head:opacity-100 group-hover/head:opacity-100 has-[[data-state=open]]:opacity-100")}>
      <DropdownMenu.Trigger
        className={clsx(
          "rounded px-1.5 py-0.5 text-xs transition hover:bg-panel-2 data-[state=open]:bg-panel-2",
          active ? "bg-accent/10 text-accent" : "text-muted hover:text-fg",
          active && "rounded-r-none",
        )}
      >
        {active ? `${name}: ${label}` : name}
      </DropdownMenu.Trigger>
      {active && (
        <button
          className="rounded-r bg-accent/10 px-1.5 py-0.5 text-xs text-accent hover:bg-accent/20"
          aria-label={`Clear ${name.toLowerCase()}`}
          onClick={onClear}
        >
          <CloseIcon />
        </button>
      )}
    </span>
  );
}

function toggle<T>(list: T[], v: T) {
  return list.includes(v) ? list.filter((x) => x !== v) : [...list, v];
}

function Check({ checked, children, onSelect }: { checked: boolean; children: React.ReactNode; onSelect: () => void }) {
  return (
    <DropdownMenu.CheckboxItem
      checked={checked}
      className={ITEM}
      // Keep the menu open so several values can be ticked in a row.
      onSelect={(e) => {
        e.preventDefault();
        onSelect();
      }}
    >
      <span className="w-3 text-accent">{checked ? <CheckIcon /> : null}</span>
      {children}
    </DropdownMenu.CheckboxItem>
  );
}

export function ColumnControls(props: {
  view: View;
  onChange: (v: View) => void;
  members: Member[];
  labels: string[];
  cycles?: CycleOption[];
  className?: string;
}) {
  const { view, onChange, members, labels } = props;
  const cycles = props.cycles ?? [];
  const filtered = isFiltered(view);
  const set = (patch: Partial<View>) => onChange({ ...view, ...patch });

  return (
    <div className={clsx("flex items-center gap-0.5", props.className)}>
      <DropdownMenu.Root>
        <Trigger
          active={filtered}
          label={describeFilter(view, members)}
          name="Filter"
          onClear={() => onChange({ ...view, priority: [], assignee: [], label: [], cycle: [], flags: [] })}
        />
        <DropdownMenu.Portal>
          <DropdownMenu.Content align="start" sideOffset={6} collisionPadding={8} className={clsx(MENU, "max-h-96 overflow-y-auto")}>
            <div className={HEAD}>Priority</div>
            {PRIORITIES.map((p) => (
              <Check key={p} checked={view.priority.includes(p)} onSelect={() => set({ priority: toggle(view.priority, p) })}>
                {cap(p)}
              </Check>
            ))}
            <div className={HEAD}>Assignee</div>
            <Check checked={view.assignee.includes("none")} onSelect={() => set({ assignee: toggle(view.assignee, "none") })}>
              Unassigned
            </Check>
            {members.map((m) => (
              <Check key={m.id} checked={view.assignee.includes(m.id)} onSelect={() => set({ assignee: toggle(view.assignee, m.id) })}>
                {m.name}
              </Check>
            ))}
            {labels.length > 0 && <div className={HEAD}>Label</div>}
            {labels.map((l) => (
              <Check key={l} checked={view.label.includes(l)} onSelect={() => set({ label: toggle(view.label, l) })}>
                {l}
              </Check>
            ))}
            {cycles.length > 0 && <div className={HEAD}>Cycle</div>}
            {cycles.length > 0 && (
              <Check checked={view.cycle.includes("none")} onSelect={() => set({ cycle: toggle(view.cycle, "none") })}>
                No cycle
              </Check>
            )}
            {cycles.map((c) => (
              <Check key={c.number} checked={view.cycle.includes(String(c.number))} onSelect={() => set({ cycle: toggle(view.cycle, String(c.number)) })}>
                {c.name ? `Cycle ${c.number}: ${c.name}` : `Cycle ${c.number}`}
                {c.state === "current" && <span className="ml-1 text-xs text-ok">now</span>}
              </Check>
            ))}
            <div className={HEAD}>Ticket</div>
            {FLAGS.map((f) => (
              <Check key={f.value} checked={view.flags.includes(f.value)} onSelect={() => set({ flags: toggle(view.flags, f.value) })}>
                {f.label}
              </Check>
            ))}
            {filtered && (
              <>
                <DropdownMenu.Separator className="my-1 h-px bg-line" />
                <DropdownMenu.Item className={clsx(ITEM, "text-muted")} onSelect={() => set({ priority: [], assignee: [], label: [], cycle: [], flags: [] })}>
                  Clear
                </DropdownMenu.Item>
              </>
            )}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>

      <DropdownMenu.Root>
        <Trigger active={!!view.sort} label={describeSort(view)} name="Sort" onClear={() => set({ sort: null })} />
        <DropdownMenu.Portal>
          <DropdownMenu.Content align="start" sideOffset={6} collisionPadding={8} className={MENU}>
            <DropdownMenu.RadioGroup
              value={view.sort?.key ?? "manual"}
              onValueChange={(k) => set({ sort: k === "manual" ? null : { key: k as SortKey, dir: view.sort?.dir ?? (k === "title" || k === "number" ? "asc" : "desc") } })}
            >
              <DropdownMenu.RadioItem value="manual" className={ITEM}>
                <span className="w-3 text-accent">{!view.sort ? <CheckIcon /> : null}</span>Manual (drag order)
              </DropdownMenu.RadioItem>
              {SORTS.map((s) => (
                <DropdownMenu.RadioItem key={s.value} value={s.value} className={ITEM}>
                  <span className="w-3 text-accent">{view.sort?.key === s.value ? <CheckIcon /> : null}</span>
                  {s.label}
                </DropdownMenu.RadioItem>
              ))}
            </DropdownMenu.RadioGroup>
            {view.sort && (
              <>
                <DropdownMenu.Separator className="my-1 h-px bg-line" />
                <DropdownMenu.Item
                  className={ITEM}
                  onSelect={(e) => {
                    e.preventDefault();
                    set({ sort: { ...view.sort!, dir: view.sort!.dir === "asc" ? "desc" : "asc" } });
                  }}
                >
                  {view.sort.dir === "asc" ? "Ascending ↑ (switch to descending)" : "Descending ↓ (switch to ascending)"}
                </DropdownMenu.Item>
                <DropdownMenu.Item className={clsx(ITEM, "text-muted")} onSelect={() => set({ sort: null })}>
                  Clear
                </DropdownMenu.Item>
              </>
            )}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </div>
  );
}
