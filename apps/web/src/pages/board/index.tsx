import { useMemo } from "react";
import { useParams } from "react-router";
import { Loaded } from "../../components/query-state";
import { SetupChecklist } from "../../components/setup-checklist";
import { useBoard } from "../../lib/queries";
import { Board } from "./board";

/** `/p/:key`: the project's kanban board, with the setup checklist above it. */
export function BoardPage() {
  const { key = "" } = useParams();
  const query = useBoard(key);
  return (
    <Loaded query={query} label="Loading the board" rows={5}>
      {(board) => <BoardScreen board={board} />}
    </Loaded>
  );
}

function BoardScreen({ board }: { board: NonNullable<ReturnType<typeof useBoard>["data"]> }) {
  // A refresh hands over equal data in a new array; the board only re-reads its columns when they really change.
  const columns = useMemo(() => board.columns.map(({ id, name }) => ({ id, name })), [board.columns]);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 px-4 pt-4">
        <SetupChecklist state={board.checklist} />
      </div>
      <div className="min-h-0 flex-1">
        <Board projectKey={board.project.key} columns={columns} tickets={board.tickets} nodes={board.nodes} members={board.members} />
      </div>
    </div>
  );
}
