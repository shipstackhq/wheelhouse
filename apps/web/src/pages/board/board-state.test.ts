import { describe, expect, test } from "vitest";
import { dragOver, drop, findCol, group, type Items } from "./board-state";
import { COLUMNS, ticket } from "../../test/data";

/**
 * What a drag does to the board, from the two ids dnd-kit reports. (A pointer cannot be driven in jsdom; the real drag is checked
 * in a browser, and these rules are what that drag runs.)
 */
const a = ticket({ number: 1, title: "a", columnId: "c-todo", position: 1000 });
const b = ticket({ number: 2, title: "b", columnId: "c-todo", position: 2000 });
const c = ticket({ number: 3, title: "c", columnId: "c-todo", position: 3000 });
const d = ticket({ number: 4, title: "d", columnId: "c-review", position: 1000 });
const cols = COLUMNS.map(({ id, name }) => ({ id, name }));
const board = () => group(cols, [c, a, d, b]);
const refs = (items: Items, col: string) => items[col].map((t) => t.ref);

describe("group", () => {
  test("every column is there, even an empty one, and each is in position order whatever order the tickets arrive in", () => {
    const items = board();
    expect(Object.keys(items)).toEqual(COLUMNS.map((x) => x.id));
    expect(refs(items, "c-todo")).toEqual([a.ref, b.ref, c.ref]);
    expect(items["c-backlog"]).toEqual([]);
  });

  test("a ticket in a column the board does not have is left out rather than breaking it", () => {
    expect(group(cols, [ticket({ columnId: "gone" })])["gone"]).toBeUndefined();
  });
});

describe("findCol", () => {
  test("finds a card's column, and treats a column's own id as that column (an empty column is a drop target)", () => {
    const items = board();
    expect(findCol(items, b.id)).toBe("c-todo");
    expect(findCol(items, "c-backlog")).toBe("c-backlog");
    expect(findCol(items, "nobody")).toBeUndefined();
  });
});

describe("dragging over", () => {
  test("over a card in another column: it moves there, in front of that card, and says it is in that column", () => {
    const next = dragOver(board(), a.id, d.id);
    expect(refs(next, "c-todo")).toEqual([b.ref, c.ref]);
    expect(refs(next, "c-review")).toEqual([a.ref, d.ref]);
    expect(next["c-review"][0].columnId).toBe("c-review");
  });

  test("over an empty column: it goes in, as the only card", () => {
    const next = dragOver(board(), a.id, "c-backlog");
    expect(refs(next, "c-backlog")).toEqual([a.ref]);
    expect(refs(next, "c-todo")).toEqual([b.ref, c.ref]);
  });

  test("over a column that has cards but not over one of them (the gap below): it goes to the end", () => {
    expect(refs(dragOver(board(), a.id, "c-review"), "c-review")).toEqual([d.ref, a.ref]);
  });

  test("over a card in its own column, over itself, or over nothing known: nothing changes (and the same object comes back)", () => {
    const items = board();
    expect(dragOver(items, a.id, c.id)).toBe(items);
    expect(dragOver(items, a.id, a.id)).toBe(items);
    expect(dragOver(items, a.id, "nobody")).toBe(items);
    expect(dragOver(items, "nobody", c.id)).toBe(items);
  });

  test("it never changes the board it was given", () => {
    const items = board();
    const before = JSON.stringify(items);
    dragOver(items, a.id, d.id);
    expect(JSON.stringify(items)).toBe(before);
  });
});

describe("letting go", () => {
  const never = () => false;

  test("in another column: the server is told which column and the place, and that it crossed", () => {
    // While it is dragged, dnd-kit reports the card's own slot as "over" once it has moved in.
    const over = dragOver(board(), a.id, d.id);
    const res = drop(over, a.id, a.id, "c-todo", never);
    expect(res.move).toEqual({ columnId: "c-review", index: 0, crossed: true });
    expect(refs(res.items, "c-review")).toEqual([a.ref, d.ref]);
  });

  test("released over the very card it was moved in front of, it goes behind that card (as it always has)", () => {
    const over = dragOver(board(), a.id, d.id);
    const res = drop(over, a.id, d.id, "c-todo", never);
    expect(res.move).toEqual({ columnId: "c-review", index: 1, crossed: true });
    expect(refs(res.items, "c-review")).toEqual([d.ref, a.ref]);
  });

  test("into an empty column", () => {
    const over = dragOver(board(), a.id, "c-backlog");
    expect(drop(over, a.id, "c-backlog", "c-todo", never).move).toEqual({ columnId: "c-backlog", index: 0, crossed: true });
  });

  test("below the last card of another column: it ends up last", () => {
    const over = dragOver(board(), a.id, "c-review");
    expect(drop(over, a.id, "c-review", "c-todo", never).move).toEqual({ columnId: "c-review", index: 1, crossed: true });
  });

  test("reordering in the same column: the cards are reordered at once and the new place is sent", () => {
    const res = drop(board(), a.id, c.id, "c-todo", never);
    expect(refs(res.items, "c-todo")).toEqual([b.ref, c.ref, a.ref]);
    expect(res.move).toEqual({ columnId: "c-todo", index: 2, crossed: false });
    expect(refs(drop(board(), c.id, a.id, "c-todo", never).items, "c-todo")).toEqual([c.ref, a.ref, b.ref]);
  });

  test("released over nothing (dropped outside the board), or over a card that is gone: no change is sent", () => {
    expect(drop(board(), a.id, null, "c-todo", never).move).toBeNull();
    expect(drop(board(), "nobody", c.id, "c-todo", never).move).toBeNull();
  });

  test("picked up and put straight back where it was, over nothing: no change is sent", () => {
    expect(drop(board(), a.id, "c-todo", "c-todo", never).move).toBeNull();
  });

  test("released over itself in the same column: it is sent as it was (the same place), as before", () => {
    expect(drop(board(), b.id, b.id, "c-todo", never).move).toEqual({ columnId: "c-todo", index: 1, crossed: false });
  });

  test("a column sorted by a field has no manual order: putting a card back in it changes nothing, but a card can still arrive from another column", () => {
    const sorted = (col: string) => col === "c-todo";
    expect(drop(board(), a.id, c.id, "c-todo", sorted)).toEqual({ items: board(), move: null });
    const over = dragOver(board(), d.id, c.id);
    const res = drop(over, d.id, c.id, "c-review", sorted);
    expect(res.move).toMatchObject({ columnId: "c-todo", crossed: true });
  });

  test("a whole drag, step by step, ends where the card was dropped", () => {
    let items = board();
    items = dragOver(items, b.id, d.id); // across
    items = dragOver(items, b.id, "c-backlog"); // changed its mind: to the empty column
    items = dragOver(items, b.id, a.id); // and back among the first column's cards
    const res = drop(items, b.id, a.id, "c-todo", never);
    expect(res.move?.columnId).toBe("c-todo");
    expect(refs(res.items, "c-todo")).toContain(b.ref);
    const total = Object.values(res.items).flat().length;
    expect(total).toBe(4); // nothing lost, nothing duplicated
    expect(new Set(Object.values(res.items).flat().map((t) => t.id)).size).toBe(4);
  });
});
