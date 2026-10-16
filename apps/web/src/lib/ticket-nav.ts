/**
 * The pure parts of the ticket dialog: which ticket `?t=` names, which tickets sit
 * before and after it, whether closing would lose work, and when arrow keys move
 * between tickets. Kept free of React so they can be tested directly.
 */

/** A ticket ref like WH-49. Anything else in `?t=` is ignored rather than fetched. */
export function parseTicketParam(value: string | null | undefined): string | null {
  const v = value?.trim();
  if (!v || !/^[A-Za-z][A-Za-z0-9]{0,11}-\d{1,9}$/.test(v)) return null;
  return v.toUpperCase();
}

export type Neighbours = { index: number; total: number; prev: string | null; next: string | null };

/** Where `current` sits in `refs` (the tickets of its column, in the order the board shows them). */
export function neighbours(refs: string[], current: string): Neighbours {
  const index = refs.indexOf(current);
  if (index < 0) return { index: -1, total: refs.length, prev: null, next: null };
  return { index, total: refs.length, prev: index > 0 ? refs[index - 1] : null, next: index < refs.length - 1 ? refs[index + 1] : null };
}

/** True when closing or switching ticket would throw away something the person typed. */
export function isDirty(s: { editingBody: boolean; body: string; savedBody: string; comment: string; title: string; savedTitle: string; labelsPending?: boolean }): boolean {
  return (s.editingBody && s.body !== s.savedBody) || s.comment.trim() !== "" || s.title !== s.savedTitle || !!s.labelsPending;
}

type KeyTarget = { tagName?: string; isContentEditable?: boolean; closest?: (selector: string) => unknown };

/** Elements that use the arrow keys themselves: text fields, selects and menus, and the discard confirmation. */
const OWN_ARROWS = 'input, textarea, select, [contenteditable="true"], [role="listbox"], [role="menu"], [role="combobox"], [role="alertdialog"]';

export function usesArrowKeys(target: KeyTarget | null | undefined): boolean {
  if (!target) return false;
  if (target.isContentEditable) return true;
  if (["INPUT", "TEXTAREA", "SELECT"].includes(String(target.tagName).toUpperCase())) return true;
  return !!target.closest?.(OWN_ARROWS);
}

/** -1 for the previous ticket, 1 for the next, 0 when the key press is not ours to handle. */
export function arrowStep(e: { key: string; altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean; defaultPrevented?: boolean; isComposing?: boolean; target?: KeyTarget | null }): -1 | 0 | 1 {
  if (e.defaultPrevented || e.isComposing || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return 0;
  if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return 0;
  if (usesArrowKeys(e.target)) return 0;
  return e.key === "ArrowLeft" ? -1 : 1;
}

/** A title is one line of meaning even when it wraps on screen: line breaks (typed or pasted) become single spaces. */
export function singleLine(text: string): string {
  return text.replace(/\s*[\r\n]+\s*/g, " ");
}
