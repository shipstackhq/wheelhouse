/**
 * Issue labels as the UI edits them. Underneath they are still a comma-separated string ("bug, frontend"):
 * the pill field takes and gives that string, and these helpers are the only place it is split or joined.
 */

const key = (l: string) => l.trim().toLowerCase();

/** "bug, frontend" -> ["bug", "frontend"]: trimmed, no empties, no duplicates (case-insensitive, first spelling wins). */
export function parseLabels(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of text.split(/[,\n]/)) {
    const l = part.trim();
    if (l && !seen.has(key(l))) {
      seen.add(key(l));
      out.push(l);
    }
  }
  return out;
}

export const formatLabels = (labels: string[]): string => labels.join(", ");

/** Add whatever labels `input` contains (it may be several, comma-separated) to `current`, skipping ones already there. */
export function addLabels(current: string[], input: string): string[] {
  return parseLabels(formatLabels(current) + "," + input);
}

export const removeLabel = (current: string[], label: string): string[] => current.filter((l) => key(l) !== key(label));

export type LabelsState = { labels: string[]; text: string };

/** Typing: a comma (typed or pasted) finishes a label; whatever follows the last comma stays in the box. */
export function applyText(state: LabelsState, text: string): LabelsState {
  if (!text.includes(",")) return { ...state, text };
  const parts = text.split(",");
  const rest = parts.pop() ?? "";
  return { labels: addLabels(state.labels, parts.join(",")), text: rest.replace(/^\s+/, "") };
}

/**
 * Keys in the label box. Enter or comma turns the typed text into a label; Backspace in an empty box removes the last one.
 * `prevent` says the browser should not also handle the key.
 */
export function applyKey(state: LabelsState, key: string): LabelsState & { prevent: boolean } {
  if (key === "Enter" || key === ",") {
    return { labels: state.text.trim() ? addLabels(state.labels, state.text) : state.labels, text: "", prevent: true };
  }
  if (key === "Backspace" && state.text === "" && state.labels.length) {
    return { labels: state.labels.slice(0, -1), text: "", prevent: true };
  }
  return { ...state, prevent: false };
}

/** The labels as they will be saved once the typed text is turned into a label (e.g. on blur). */
export const settle = (state: LabelsState): string[] => (state.text.trim() ? addLabels(state.labels, state.text) : state.labels);
