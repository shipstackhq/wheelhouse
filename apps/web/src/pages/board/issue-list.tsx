import { useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import clsx from "clsx";
import { DropdownMenu } from "radix-ui";
import type { BoardStatus, CycleOption, TeamProjectOption } from "@wheelhouse/api-client";
import { AddIcon, AgentIcon, ChevronDownIcon, ChevronRightIcon, CommentIcon, CyclesIcon, ProjectsIcon } from "../../components/icons";
import { Avatar } from "../../components/avatar";
import { SubIssueProgress } from "../../components/sub-issue-progress";
import { PRIORITY_LABEL, PRIORITY_ORDER, PriorityIcon } from "../../components/priority-icon";
import { StatusIcon } from "../../components/status-icon";
import { describeFailure } from "../../lib/form-state";
import { loadFolded, saveFolded } from "../../lib/issue-layout";
import { neighbours, parseIssueParam } from "../../lib/issue-nav";
import { groupIssues, startingFields, type GroupKind, type IssueGroup, type IssueView } from "../../lib/issue-view";
import { arrangeRows, type ListRow } from "../../lib/sub-issues";
import { useServices } from "../../lib/services";
import { cycleTitle } from "../cycles/cycle-bits";
import { IssueDialog } from "./issue-dialog";
import type { Issue, Member, NodeLite } from "./shared";

const MENU = "z-50 min-w-48 max-h-80 overflow-y-auto rounded-lg border border-line bg-panel p-1 text-sm text-fg shadow-xl";
const ITEM = "flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 outline-none data-[highlighted]:bg-panel-2";
const CELL = "rounded p-1 outline-none hover:bg-panel-2 focus-visible:ring-2 focus-visible:ring-accent/50 data-[state=open]:bg-panel-2";

const shortDate = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });

/**
 * The team's issues as a list: a group for each status in board order (an empty status still has its group, to add into), a row for each
 * issue with its priority, ref, status, title, labels, project, cycle, assignee and last change. Priority, status and assignee change right
 * in the row; the title opens the issue (`?t=`, like the board's cards). Groups fold away and stay folded in this browser.
 */
export function IssueList(props: {
  teamKey: string;
  statuses: BoardStatus[];
  /** The issues the view lets through (already filtered); the list groups and orders them by the view. */
  issues: Issue[];
  /** Every issue of the team, filtered or not: a parent's progress counts all its sub-issues. */
  allIssues: Issue[];
  view: IssueView;
  /** True when the view hides something, so an empty list can say why and offer to undo it. */
  filtered: boolean;
  onClearFilters: () => void;
  nodes: NodeLite[];
  members: Member[];
  cycles: CycleOption[];
  projects: TeamProjectOption[];
}) {
  const { teamKey, statuses, issues, allIssues, view, nodes, members, cycles, projects } = props;
  const { api, queryClient } = useServices();
  const [search, setSearch] = useSearchParams();
  const [folded, setFolded] = useState(() => loadFolded(teamKey));
  const [error, setError] = useState<string | null>(null);
  const openRef = parseIssueParam(search.get("t"));

  const groups = useMemo(() => groupIssues(issues, view, { statuses, members, projects, cycles }), [issues, view, statuses, members, projects, cycles]);
  const roleOf = useMemo(() => {
    const roles = new Map(statuses.map((s) => [s.id, s.role]));
    return (statusId: string) => roles.get(statusId) ?? null;
  }, [statuses]);
  // Parents folded away are kept with the folded groups, as "issue:<id>".
  const foldedParents = useMemo(() => new Set([...folded].filter((f) => f.startsWith("issue:")).map((f) => f.slice(6))), [folded]);
  const rowsOf = (g: IssueGroup): ListRow[] => arrangeRows(g.issues, allIssues, { showSub: view.showSub, nest: view.nest, folded: foldedParents }, roleOf);
  const memberName = useMemo(() => new Map(members.map((m) => [m.id, m.name])), [members]);

  /** One change, then the board is read again whatever happened, so the list shows the server's answer (and undoes a refusal). */
  const act = async (change: () => Promise<unknown>) => {
    setError(null);
    try {
      await change();
    } catch (e) {
      setError(describeFailure(e));
    } finally {
      await queryClient.invalidateQueries({ queryKey: ["board", teamKey] });
    }
  };
  const toggle = (id: string) => {
    const next = new Set(folded);
    if (!next.delete(id)) next.add(id);
    setFolded(next);
    saveFolded(teamKey, next);
  };
  const openIssue = (ref: string | null) => {
    const sp = new URLSearchParams(search);
    if (ref) sp.set("t", ref);
    else sp.delete("t");
    setSearch(sp, { replace: true, preventScrollReset: true });
  };
  // Previous and next in the dialog walk the list in the order it shows, folded groups included.
  const order = groups.flatMap((g) => rowsOf(g).map((r) => r.issue.ref));

  return (
    <div className="h-full overflow-y-auto">
      {error && (
        <div role="alert" className="mx-4 mt-3 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
          {error}
        </div>
      )}
      <div className="pb-8">
        {props.filtered && order.length === 0 && (
          <div className="px-4 py-10 text-center text-sm text-muted">
            <p>No issues match.</p>
            <button type="button" className="mt-2 text-accent hover:underline" onClick={props.onClearFilters}>Clear filters</button>
          </div>
        )}
        {groups.map((g) => (
          <section key={g.id} aria-label={g.label}>
            <GroupHeader
              group={g}
              folded={folded.has(g.id)}
              onToggle={() => toggle(g.id)}
              onAdd={(title) => act(() => api.issues.create(teamKey, { title, ...startingFields(g.what) }))}
            />
            {!folded.has(g.id) && (
              <ul>
                {rowsOf(g).map((r) => (
                  <Row
                    key={r.issue.id}
                    row={r}
                    onFold={() => toggle(`issue:${r.issue.id}`)}
                    parentFolded={foldedParents.has(r.issue.id)}
                    statuses={statuses}
                    members={members}
                    assignee={r.issue.assigneeId ? memberName.get(r.issue.assigneeId) : undefined}
                    nodes={nodes}
                    cycles={cycles}
                    projects={projects}
                    selected={r.issue.ref === openRef}
                    onOpen={() => openIssue(r.issue.ref)}
                    onStatus={(statusId) => act(() => api.issues.move(r.issue.ref, { status: statusId }))}
                    onPriority={(priority) => act(() => api.issues.update(r.issue.ref, { priority, version: r.issue.version }))}
                    onAssignee={(assigneeId) => act(() => api.issues.update(r.issue.ref, { assigneeId, version: r.issue.version }))}
                  />
                ))}
              </ul>
            )}
          </section>
        ))}
      </div>
      {openRef && (
        <IssueDialog
          key={openRef}
          issueRef={openRef}
          teamKey={teamKey}
          columns={statuses.map(({ id, name }) => ({ id, name }))}
          nodes={nodes}
          members={members}
          cycles={cycles}
          projects={projects}
          nav={neighbours(order, openRef)}
          onNavigate={openIssue}
          onClose={() => openIssue(null)}
        />
      )}
    </div>
  );
}

/** The icon that says what a group is: its status, its priority, the person, the project or the cycle. */
function GroupIcon({ what }: { what: GroupKind }) {
  switch (what.kind) {
    case "status": return <StatusIcon role={what.status.role} color={what.status.color} />;
    case "priority": return <PriorityIcon priority={what.priority} />;
    case "assignee": return <Avatar name={what.member?.name} />;
    case "project": return <ProjectsIcon aria-hidden className="text-muted" />;
    case "cycle": return <CyclesIcon aria-hidden className="text-muted" />;
    case "none": return null;
  }
}

function GroupHeader(props: { group: IssueGroup; folded: boolean; onToggle: () => void; onAdd: (title: string) => void }) {
  const { group } = props;
  const count = group.issues.length;
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const close = () => {
    setAdding(false);
    setTitle("");
  };
  return (
    <div className="sticky top-0 z-10 border-y border-line bg-panel-2/95 backdrop-blur">
      <div className="flex items-center gap-2 px-4 py-1.5">
        <button type="button" aria-expanded={!props.folded} aria-label={`${group.label}, ${count} ${count === 1 ? "issue" : "issues"}`} onClick={props.onToggle} className="flex min-w-0 items-center gap-2 rounded outline-none focus-visible:ring-2 focus-visible:ring-accent/50">
          {props.folded ? <ChevronRightIcon aria-hidden className="text-muted" /> : <ChevronDownIcon aria-hidden className="text-muted" />}
          <GroupIcon what={group.what} />
          <span className="truncate text-sm font-medium">{group.label}</span>
          <span className="text-xs tabular-nums text-muted">{count}</span>
        </button>
        <button type="button" aria-label={`Add an issue to ${group.label}`} className="ml-auto rounded p-1 text-muted outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-accent/50" onClick={() => setAdding(true)}>
          <AddIcon aria-hidden />
        </button>
      </div>
      {adding && (
        <form
          className="flex items-center gap-2 border-t border-line bg-panel px-4 py-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            const v = title.trim();
            if (v) props.onAdd(v);
            close();
          }}
        >
          <GroupIcon what={group.what} />
          <input
            autoFocus
            className="min-w-0 flex-1 bg-transparent py-1 text-sm outline-none placeholder:text-muted"
            aria-label={`New issue in ${group.label}`}
            placeholder="Issue title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && close()}
          />
          <button type="submit" className="btn btn-primary py-0.5 text-xs">Add</button>
        </form>
      )}
    </div>
  );
}

function Row(props: {
  row: ListRow;
  onFold: () => void;
  parentFolded: boolean;
  statuses: BoardStatus[];
  members: Member[];
  assignee: string | undefined;
  nodes: NodeLite[];
  cycles: CycleOption[];
  projects: TeamProjectOption[];
  selected: boolean;
  onOpen: () => void;
  onStatus: (statusId: string) => void;
  onPriority: (priority: Issue["priority"]) => void;
  onAssignee: (assigneeId: string | null) => void;
}) {
  const { issue: t, depth, progress, childrenHere, parentRef } = props.row;
  const { statuses } = props;
  const status = statuses.find((s) => s.id === t.statusId);
  const project = t.projectId ? props.projects.find((x) => x.id === t.projectId) : undefined;
  const cycle = t.cycle == null ? null : (props.cycles.find((c) => c.number === t.cycle) ?? { number: t.cycle, name: "", startsAt: "", endsAt: "", state: "current" as const });
  return (
    <li
      className={clsx("flex items-center gap-1.5 border-b border-line py-1 pr-3 text-sm hover:bg-panel-2/60", props.selected && "bg-accent/10")}
      style={{ paddingLeft: 12 + depth * 20 }}
      data-issue={t.ref}
      data-depth={depth}
    >
      {childrenHere > 0 ? (
        <button
          type="button"
          aria-expanded={!props.parentFolded}
          aria-label={`${props.parentFolded ? "Show" : "Hide"} the sub-issues of ${t.ref}`}
          onClick={props.onFold}
          className="rounded p-0.5 text-muted outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-accent/50"
        >
          {props.parentFolded ? <ChevronRightIcon aria-hidden /> : <ChevronDownIcon aria-hidden />}
        </button>
      ) : (
        <span aria-hidden className="inline-block w-5 shrink-0" />
      )}
      <Menu
        label={`Priority of ${t.ref}: ${PRIORITY_LABEL[t.priority]}`}
        trigger={<PriorityIcon priority={t.priority} />}
        items={PRIORITY_ORDER.map((p) => ({ key: p, label: PRIORITY_LABEL[p], icon: <PriorityIcon priority={p} />, current: p === t.priority, onSelect: () => p !== t.priority && props.onPriority(p) }))}
      />
      <span className="w-16 shrink-0 font-mono text-[11px] text-muted">{t.ref}</span>
      <Menu
        label={`Status of ${t.ref}: ${status?.name ?? ""}`}
        trigger={<StatusIcon role={status?.role ?? ""} color={status?.color ?? null} />}
        items={statuses.map((s) => ({ key: s.id, label: s.name, icon: <StatusIcon role={s.role} color={s.color} />, current: s.id === t.statusId, onSelect: () => s.id !== t.statusId && props.onStatus(s.id) }))}
      />
      <button type="button" onClick={props.onOpen} className="min-w-0 flex-1 truncate rounded px-1 py-0.5 text-left outline-none hover:underline focus-visible:ring-2 focus-visible:ring-accent/50">
        {t.title}
      </button>
      <div className="hidden shrink-0 items-center gap-1 md:flex">
        {parentRef && (
          <span className="chip bg-bg text-muted" title={`Sub-issue of ${parentRef}`} data-parent-chip>
            ↳ {parentRef}
          </span>
        )}
        {progress && <SubIssueProgress progress={progress} />}
        {t.createdByKind === "agent" && <span className="chip bg-agent/15 text-agent" title="Created by an agent"><AgentIcon /></span>}
        {t.labels.slice(0, 3).map((l) => (
          <span key={l} className="chip bg-bg text-muted">{l}</span>
        ))}
        {t.labels.length > 3 && <span className="text-[11px] text-muted" title={t.labels.slice(3).join(", ")}>+{t.labels.length - 3}</span>}
        {project && (
          <span className="chip max-w-[9rem] bg-accent/10 text-accent/90" title={`Project: ${project.name}`} data-project-chip>
            <ProjectsIcon /> <span className="truncate">{project.name}</span>
          </span>
        )}
        {cycle && (
          <span className="chip bg-ok/10 text-ok" title={cycleTitle(cycle)} data-cycle-chip>
            <CyclesIcon /> {cycle.number}
          </span>
        )}
        {t.commentCount > 0 && (
          <span className="text-[11px] text-muted" title={`${t.commentCount} comments`}>
            <CommentIcon /> {t.commentCount}
          </span>
        )}
      </div>
      <Menu
        label={`Assignee of ${t.ref}: ${props.assignee ?? "nobody"}`}
        trigger={<Avatar name={props.assignee} />}
        items={[
          { key: "none", label: "Unassigned", icon: <Avatar />, current: !t.assigneeId, onSelect: () => t.assigneeId && props.onAssignee(null) },
          ...props.members.map((m) => ({ key: m.id, label: m.name, icon: <Avatar name={m.name} />, current: m.id === t.assigneeId, onSelect: () => m.id !== t.assigneeId && props.onAssignee(m.id) })),
        ]}
      />
      <span className="hidden w-12 shrink-0 text-right text-[11px] text-muted sm:block" title={`Updated ${new Date(t.updatedAt).toLocaleString()}`}>
        {shortDate(t.updatedAt)}
      </span>
    </li>
  );
}

/** A small button that opens a menu to pick one value, the current one marked. */
function Menu(props: { label: string; trigger: React.ReactNode; items: { key: string; label: string; icon: React.ReactNode; current: boolean; onSelect: () => void }[] }) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger aria-label={props.label} className={CELL}>
        {props.trigger}
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="start" sideOffset={4} collisionPadding={8} className={MENU}>
          {props.items.map((i) => (
            <DropdownMenu.Item key={i.key} className={clsx(ITEM, i.current && "text-accent")} onSelect={i.onSelect} aria-current={i.current || undefined}>
              {i.icon}
              <span className="truncate">{i.label}</span>
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
