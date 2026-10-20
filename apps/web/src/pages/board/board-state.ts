import { arrayMove } from "@dnd-kit/sortable";
import type { Col, Issue } from "./shared";

/**
 * The board's issues by column, and what a drag does to them. Kept apart from the component so the rules can be tested
 * without a pointer: dnd-kit only reports "this id is over that id", and everything below works from those two ids.
 */
export type Items = Record<string, Issue[]>;

/** Issues by column id, each column in position order. An issue whose column is not in the list is dropped. */
export function group(cols: Col[], issues: Issue[]): Items {
  const m: Items = {};
  for (const c of cols) m[c.id] = [];
  for (const t of [...issues].sort((a, b) => a.position - b.position)) m[t.columnId]?.push(t);
  return m;
}

/** The column a draggable id lives in, where the id may also be a column's own id (an empty column is a drop target). */
export const findCol = (items: Items, id: string) => (items[id] ? id : Object.keys(items).find((c) => items[c].some((t) => t.id === id)));

/**
 * The card is dragged over another card or a column: if that is another column, it moves there at once (in front of the card it
 * is over, or at the end of an empty or column-wide target) so the board shows where it would land.
 */
export function dragOver(prev: Items, activeId: string, overId: string): Items {
  const from = findCol(prev, activeId);
  const to = findCol(prev, overId);
  if (!from || !to || from === to) return prev;
  const moving = prev[from].find((t) => t.id === activeId);
  if (!moving) return prev;
  const overIdx = prev[to].findIndex((t) => t.id === overId);
  const idx = overIdx >= 0 ? overIdx : prev[to].length;
  return {
    ...prev,
    [from]: prev[from].filter((t) => t.id !== activeId),
    [to]: [...prev[to].slice(0, idx), { ...moving, columnId: to }, ...prev[to].slice(idx)],
  };
}

export type DropResult = {
  items: Items;
  /** What to tell the server, or null when nothing changed or the drop does not count. */
  move: { columnId: string; index: number; crossed: boolean } | null;
};

/**
 * The card is released. `dragFrom` is the column it was picked up from; `sorted(col)` says whether a column is sorted by a field
 * (its order is then not manual, so putting a card back in the same column changes nothing).
 */
export function drop(items: Items, activeId: string, overId: string | null, dragFrom: string | null, sorted: (colId: string) => boolean): DropResult {
  const col = findCol(items, activeId);
  if (!overId || !col) return { items, move: null };
  let list = items[col];
  const oldIdx = list.findIndex((t) => t.id === activeId);
  const overIdx = list.findIndex((t) => t.id === overId);
  if (sorted(col) && dragFrom === col) return { items, move: null };
  let next = items;
  if (overIdx >= 0 && oldIdx !== overIdx) {
    list = arrayMove(list, oldIdx, overIdx);
    next = { ...items, [col]: list };
  }
  const index = list.findIndex((t) => t.id === activeId);
  if (dragFrom === col && oldIdx === index && overIdx < 0) return { items: next, move: null };
  return { items: next, move: { columnId: col, index, crossed: dragFrom !== col } };
}
