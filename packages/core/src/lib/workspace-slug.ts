import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import { schema, type DB } from "../db";

/** A name as an address: lowercase letters, digits and single dashes. "Babbage & Co" is "babbage-co". */
export function slugify(name: string): string {
  const s = name.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");
  return s || "workspace";
}

/** The slug for a new workspace: the name's, with a short random suffix when another workspace already has it. */
export async function newWorkspaceSlug(db: Pick<DB, "select">, name: string): Promise<string> {
  const base = slugify(name);
  for (let attempt = 0; attempt < 5; attempt++) {
    const slug = attempt === 0 ? base : `${base}-${crypto.randomBytes(3).toString("hex")}`;
    const [taken] = await db.select({ id: schema.workspaces.id }).from(schema.workspaces).where(eq(schema.workspaces.slug, slug));
    if (!taken) return slug;
  }
  return `${base}-${crypto.randomUUID().replace(/-/g, "")}`;
}
