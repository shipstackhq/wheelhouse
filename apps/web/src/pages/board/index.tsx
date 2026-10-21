import { useMemo, useState } from "react";
import clsx from "clsx";
import { useParams } from "react-router";
import { Loaded } from "../../components/query-state";
import { useBoard } from "../../lib/queries";
import { LAYOUTS, loadLayout, saveLayout, type Layout } from "../../lib/issue-layout";
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
  const groups = useMemo(() => groupIssues(shown, view, ctx, { keepEmpty: layout === "board" }), [shown, view, ctx, layout]);
  const choose = (next: Layout) => {
    saveLayout(teamKey, next);
    setChosen({ team: teamKey, layout: next });
  };
  return (
    <div className="flex h-full min-h-0 flex-col">
      <h1 className="sr-only">{board.team.name}</h1> {/* the header's breadcrumbs name the team, but are not a heading */}
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 px-4 pb-2 pt-3">
        <IssueViewBar view={view} onChange={changeView} ctx={ctx} />
        <div role="group" aria-label="Layout" className="inline-flex rounded-full border border-line bg-panel-2 p-0.5 text-xs">
          {LAYOUTS.map((l) => (
            <button
              key={l}
              type="button"
              aria-pressed={layout === l}
              onClick={() => choose(l)}
              className={clsx("rounded-full px-3 py-1 capitalize outline-none focus-visible:ring-2 focus-visible:ring-accent/50", layout === l ? "bg-panel text-fg shadow-sm" : "text-muted hover:text-fg")}
            >
              {l}
            </button>
          ))}
        </div>
      </div>
      <div className="min-h-0 flex-1">
        {layout === "list" ? (
          <IssueList teamKey={teamKey} statuses={board.statuses} issues={shown} view={view} filtered={isFiltered(view)} onClearFilters={() => changeView({ ...view, filters: EMPTY_FILTERS, search: "" })} nodes={board.nodes} members={board.members} cycles={board.cycles} projects={board.projects} />
        ) : (
          <Board teamKey={teamKey} groups={groups} statuses={columns} manualOrder={view.groupBy === "status" && view.sort.key === "manual"} nodes={board.nodes} members={board.members} cycles={board.cycles} projects={board.projects} />
        )}
      </div>
    </div>
  );
}
