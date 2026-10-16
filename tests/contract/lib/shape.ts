/**
 * The structure of a value with the values removed: object keys (sorted) and the type at each leaf. Lets a golden file pin
 * the shape of a response without being thrown by ids, timestamps and text. Arrays are the merge of all their elements, and
 * a field that is sometimes one type and sometimes another shows both, e.g. "string|null".
 */
export type Shape = string | Shape[] | { [k: string]: Shape };

function merge(a: Shape, b: Shape): Shape {
  if (JSON.stringify(a) === JSON.stringify(b)) return a;
  if (typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    const out: { [k: string]: Shape } = {};
    for (const k of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
      out[k] = k in a && k in b ? merge(a[k], b[k]) : k in a ? a[k] : b[k];
    }
    return out;
  }
  if (Array.isArray(a) && Array.isArray(b)) return a.length ? (b.length ? [merge(a[0], b[0])] : a) : b;
  const flat = (s: Shape) => (typeof s === "string" ? s.split("|") : [JSON.stringify(s)]);
  return [...new Set([...flat(a), ...flat(b)])].sort().join("|");
}

export function shape(v: unknown): Shape {
  if (v === null) return "null";
  if (Array.isArray(v)) return v.length ? [v.map(shape).reduce(merge)] : [];
  if (typeof v === "object") return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, shape((v as Record<string, unknown>)[k])]));
  return typeof v;
}
