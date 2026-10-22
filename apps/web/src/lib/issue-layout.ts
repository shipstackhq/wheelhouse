/**
 * How a team's issues are laid out: a list grouped by status, or a board with a column per status. It is the same issues either way, so
 * the choice is only a preference, remembered in this browser per team. The list is what a team that has not chosen gets.
 */
export type Layout = "list" | "board";

export const LAYOUTS: Layout[] = ["list", "board"];
const key = (teamKey: string) => `wh:layout:${teamKey}`;

export function loadLayout(teamKey: string): Layout {
  try {
    const v = localStorage.getItem(key(teamKey));
    if (v === "list" || v === "board") return v;
  } catch {
    /* no storage: the default */
  }
  return "list";
}

export function saveLayout(teamKey: string, layout: Layout) {
  try {
    localStorage.setItem(key(teamKey), layout);
  } catch {
    /* no storage: it lasts until the page is closed */
  }
}

/** Which groups of the list are folded away, by group id, remembered per team. */
const foldKey = (teamKey: string) => `wh:list-folded:${teamKey}`;

export function loadFolded(teamKey: string): Set<string> {
  try {
    const v = JSON.parse(localStorage.getItem(foldKey(teamKey)) ?? "[]");
    if (Array.isArray(v)) return new Set(v.filter((x): x is string => typeof x === "string"));
  } catch {
    /* unreadable: none folded */
  }
  return new Set();
}

export function saveFolded(teamKey: string, folded: Set<string>) {
  try {
    localStorage.setItem(foldKey(teamKey), JSON.stringify([...folded]));
  } catch {
    /* no storage */
  }
}
