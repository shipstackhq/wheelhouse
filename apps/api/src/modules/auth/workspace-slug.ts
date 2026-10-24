import crypto from "node:crypto";

/** A name as an address: lowercase letters, digits and single dashes. "Babbage & Co" is "babbage-co". */
export function slugify(name: string): string {
  const s = name.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");
  return s || "workspace";
}

/**
 * The slug for a new workspace: the name's, with a short random suffix when `taken` says another workspace already has it. `taken` is
 * the repository's lookup, so this file stays free of the database.
 */
export async function newWorkspaceSlug(name: string, taken: (slug: string) => Promise<boolean>): Promise<string> {
  const base = slugify(name);
  for (let attempt = 0; attempt < 5; attempt++) {
    const slug = attempt === 0 ? base : `${base}-${crypto.randomBytes(3).toString("hex")}`;
    if (!(await taken(slug))) return slug;
  }
  return `${base}-${crypto.randomUUID().replace(/-/g, "")}`;
}
