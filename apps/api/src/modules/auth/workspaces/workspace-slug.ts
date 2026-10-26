/** Words that are app routes or would read as one: never a workspace address. */
const RESERVED = new Set(["login", "logout", "signup", "invite", "settings", "offline", "admin", "api", "w", "new", "mcp", "static", "assets", "help", "support", "app", "www", "workspace", "workspaces"]);

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])$/; // 2-40 characters, lowercase letters, digits and dashes, none at the ends

/** The problem with a typed slug, or null when it is well formed (whether it is free is the database's to say). */
export function slugProblem(slug: string): string | null {
  if (!SLUG_RE.test(slug)) return "Use 2-40 lowercase letters, digits and dashes";
  if (RESERVED.has(slug)) return "That address is reserved";
  return null;
}

/** A name as an address: lowercase letters, digits and single dashes. "Babbage & Co" is "babbage-co". */
export function slugify(name: string): string {
  const s = name.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 36).replace(/-+$/, "");
  return s.length >= 2 ? s : "workspace";
}

/** The slug for a workspace made from a name: the name's, then `-2`, `-3`... while another workspace has it or it is reserved. `taken` is the repository's lookup. */
export async function newWorkspaceSlug(name: string, taken: (slug: string) => Promise<boolean>): Promise<string> {
  const base = slugify(name);
  for (let n = 1; ; n++) {
    const slug = n === 1 ? base : `${base}-${n}`;
    if (!RESERVED.has(slug) && !(await taken(slug))) return slug;
  }
}
