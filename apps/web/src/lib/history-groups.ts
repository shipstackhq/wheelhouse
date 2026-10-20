/**
 * Group an issue's history so the same doer isn't repeated on every line.
 * `items` are newest first. Consecutive events by the same actor join one group, unless
 * more than `gapMs` passed between them (so an agent returning the next day starts a new group).
 */
export type HistoryActor = { actorKind: "human" | "agent"; actorName: string; createdAt: Date | string };

export type HistoryGroup<T extends HistoryActor> = { actorKind: "human" | "agent"; actorName: string; items: T[]; newestAt: Date | string; oldestAt: Date | string };

export const GROUP_GAP_MS = 60 * 60e3;

const ms = (d: Date | string) => new Date(d).getTime();
const sameActor = (a: HistoryActor, b: HistoryActor) => a.actorKind === b.actorKind && a.actorName === b.actorName;

export function groupHistory<T extends HistoryActor>(items: T[], gapMs: number = GROUP_GAP_MS): HistoryGroup<T>[] {
  const groups: HistoryGroup<T>[] = [];
  for (const item of items) {
    const g = groups[groups.length - 1];
    const prev = g?.items[g.items.length - 1];
    if (g && prev && sameActor(prev, item) && Math.abs(ms(prev.createdAt) - ms(item.createdAt)) <= gapMs) {
      g.items.push(item);
      g.oldestAt = item.createdAt;
    } else {
      groups.push({ actorKind: item.actorKind, actorName: item.actorName, items: [item], newestAt: item.createdAt, oldestAt: item.createdAt });
    }
  }
  return groups;
}
