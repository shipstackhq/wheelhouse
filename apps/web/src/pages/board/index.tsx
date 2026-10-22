import { useMemo, useState } from "react";
import clsx from "clsx";
import { useParams } from "react-router";
import { CloseIcon } from "../../components/icons";
import { Loaded } from "../../components/query-state";
import { useBoard } from "../../lib/queries";
import { relationsOf } from "../../lib/sub-issues";
import { loadLayout, saveLayout, type Layout } from "../../lib/issue-layout";
import { EMPTY_FILTERS, filterIssues, groupIssues, isFiltered, loadIssueView, saveIssueView, type IssueView } from "../../lib/issue-view";
import { Board } from "./board";
import { IssueViewBar } from "./view-bar";
import { IssueList } from "./issue-list";

/** `/t/:key`: the team's issues, as a list grouped by status or as a kanban board (the team's own choice, remembered). */
export function BoardPage() {
  const { key = "" } = useParams();
  const query = useBoard(key);
  return (
    <Loaded query={query} label="Loading the issues" rows={5}>
      {(board) => <BoardScreen board={board} />}
    </Loaded>
  );
}

function BoardScreen({ board }: { board: NonNullable<ReturnType<typeof useBoard>["data"]> }) {
  // A refresh hands over equal data in a new array; the board only re-reads its columns when they really change.
  const columns = useMemo(() => board.statuses.map(({ id, name }) => ({ id, name })), [board.statuses]);
  const labels = useMemo(() => [...new Set(board.issues.flatMap((t) => t.labels))].sort(), [board.issues]);
  const teamKey = board.team.key;
  const [sheetOpen, setSheetOpen] = useState(false);
  const [chosen, setChosen] = useState<{ team: string; layout: Layout }>(() => ({ team: teamKey, layout: loadLayout(teamKey) }));
  // Another team has its own choice: read it when the page is for a different team than the one chosen for.
  const layout = chosen.team === teamKey ? chosen.layout : loadLayout(teamKey);
  // The view (what is kept, how it is grouped and ordered) is the team's too, and shared by both layouts.
  const [viewOf, setViewOf] = useState<{ team: string; view: IssueView }>(() => ({ team: teamKey, view: loadIssueView(teamKey) }));
  const view = viewOf.team === teamKey ? viewOf.view : loadIssueView(teamKey);
  const changeView = (next: IssueView) => {
    saveIssueView(teamKey, next);
    setViewOf({ team: teamKey, view: next });
  };
  const shown = useMemo(() => filterIssues(board.issues, view), [board.issues, view]);
  const ctx = useMemo(() => ({ statuses: board.statuses, members: board.members, projects: board.projects, cycles: board.cycles, labels }), [board.statuses, board.members, board.projects, board.cycles, labels]);
  // A list leaves out groups with nothing to show; a board keeps every column, so a card can be dropped into an empty one.
  const relations = useMemo(() => {
    const roles = new Map(board.statuses.map((s) => [s.id, s.role]));
    return relationsOf(board.issues, (id) => roles.get(id) ?? null);
  }, [board.statuses, board.issues]);
  const groups = useMemo(() => groupIssues(shown, view, ctx, { keepEmpty: layout === "board" }), [shown, view, ctx, layout]);
  const choose = (next: Layout) => {
    saveLayout(teamKey, next);
    setChosen({ team: teamKey, layout: next });
  };
  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden">
      <h1 className="sr-only">{board.team.name}</h1> {/* the header's breadcrumbs name the team, but are not a heading */}
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 px-4 py-4">
        <IssueViewBar view={view} onChange={changeView} ctx={ctx} layout={layout} onLayout={choose} sheetOpen={sheetOpen} onToggleSheet={() => setSheetOpen((o) => !o)} />
      </div>
      {/* The side sheet: it slides in from the right of this page only, over the issues, and stays out of the app's own layout. */}
      <aside
        id="issues-sheet"
        aria-label="Side sheet"
        aria-hidden={!sheetOpen}
        className={clsx(
          "absolute inset-y-0 right-0 z-30 flex w-80 max-w-full flex-col border-l border-line bg-panel shadow-xl transition-transform duration-200",
          sheetOpen ? "translate-x-0" : "pointer-events-none translate-x-full",
        )}
      >
        <div className="flex items-center justify-between px-4 py-3">
          <h2 className="text-sm font-medium">Side sheet</h2>
          <button type="button" aria-label="Close the side sheet" onClick={() => setSheetOpen(false)} className="rounded p-1 text-muted outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-accent/50">
            <CloseIcon aria-hidden />
          </button>
        </div>
      </aside>
      <div className="min-h-0 flex-1">
        {layout === "list" ? (
          <IssueList teamKey={teamKey} statuses={board.statuses} issues={shown} allIssues={board.issues} view={view} filtered={isFiltered(view)} onClearFilters={() => changeView({ ...view, filters: EMPTY_FILTERS, search: "" })} nodes={board.nodes} members={board.members} cycles={board.cycles} projects={board.projects} />
        ) : (
          <Board teamKey={teamKey} groups={groups} statuses={columns} manualOrder={view.groupBy === "status" && view.sort.key === "manual"} relations={relations} nodes={board.nodes} members={board.members} cycles={board.cycles} projects={board.projects} />
        )}
      </div>
    </div>
  );
}
