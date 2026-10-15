/** A ticket reference as people write it in branch names and pull request titles: "WH-12", "wh-12", "feature/WH-12-fix". */
const REF = /(?<![A-Za-z0-9])([A-Za-z]{2,6})-(\d{1,6})(?!\d)/g;

export type TicketRef = { key: string; number: number };

/** Every distinct reference in the text, in order of appearance, keys upper-cased. */
export function parseTicketRefs(...texts: (string | null | undefined)[]): TicketRef[] {
  const out: TicketRef[] = [];
  const seen = new Set<string>();
  for (const t of texts) {
    if (!t) continue;
    for (const m of t.matchAll(REF)) {
      const ref = { key: m[1].toUpperCase(), number: Number(m[2]) };
      const id = `${ref.key}-${ref.number}`;
      if (ref.number > 0 && !seen.has(id)) {
        seen.add(id);
        out.push(ref);
      }
    }
  }
  return out;
}

/** Only the references that belong to this project: the same repository can serve several projects, and "UTF-8" is not a ticket. */
export const refsForProject = (refs: TicketRef[], projectKey: string) => refs.filter((r) => r.key === projectKey.toUpperCase());
