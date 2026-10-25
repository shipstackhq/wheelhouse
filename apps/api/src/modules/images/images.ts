import crypto from "node:crypto";
import { and, eq } from "drizzle-orm";
import { getDb, schema } from "../../db";
import type { Human } from "../auth/index";
import { ServiceError } from "../../common/service-error";
import { getStorage, type StoredObject } from "../../platform/storage/storage";
import { canManagePeople } from "../../common/roles";

/** Custom pictures: a workspace's image and a person's profile picture. The bytes live in object storage (storage.ts), the key on the row. */

export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const TYPES: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };

/** What the bytes really are, by their first bytes; the declared type is not trusted. SVG is left out on purpose (it can carry script). */
export function sniffImageType(b: Buffer): string | null {
  if (b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length > 12 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  if (b.length > 6 && (b.toString("ascii", 0, 6) === "GIF87a" || b.toString("ascii", 0, 6) === "GIF89a")) return "image/gif";
  return null;
}

/** `{ data }` is base64 (a data URL is accepted too). Returns the bytes and their real type, or says why not. */
export function parseUpload(data: unknown): { body: Buffer; contentType: string } {
  const bad = (m: string) => new ServiceError("invalid", m, { fields: { image: m } });
  if (typeof data !== "string" || !data) throw bad("Choose an image");
  const b64 = data.replace(/^data:[^,]*;base64,/, "");
  if (b64.length > Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 4) throw bad("The image is too large (2 MB at most)");
  const body = Buffer.from(b64, "base64");
  if (!body.length) throw bad("Choose an image");
  if (body.length > MAX_IMAGE_BYTES) throw bad("The image is too large (2 MB at most)");
  const contentType = sniffImageType(body);
  if (!contentType || !TYPES[contentType]) throw bad("Use a PNG, JPEG, WebP or GIF image");
  return { body, contentType };
}

const newKey = (kind: "avatars" | "workspaces", id: string, contentType: string) => `${kind}/${id}/${crypto.randomBytes(8).toString("hex")}.${TYPES[contentType]}`;
/** Each upload gets its own key, so a changed picture is a new URL and caches never serve the old one. */
const version = (key: string | null) => (key ? key.split("/").pop()!.split(".")[0] : null);

export const avatarUrl = (userId: string, key: string | null) => (key ? `/api/app/images/users/${userId}?v=${version(key)}` : null);
export const workspaceImageUrl = (workspaceId: string, key: string | null) => (key ? `/api/app/images/workspaces/${workspaceId}?v=${version(key)}` : null);

async function dropQuietly(key: string | null) {
  if (key) await getStorage().delete(key).catch(() => {}); // an orphaned object is harmless; failing the request over it is not
}

/** Set (or with `data` null, remove) the signed-in person's own profile picture. */
export async function setAvatarAs(h: Human, data: unknown) {
  const db = await getDb();
  const old = h.user.avatarKey ?? null;
  let key: string | null = null;
  if (data !== null) {
    const { body, contentType } = parseUpload(data);
    key = newKey("avatars", h.user.id, contentType);
    await getStorage().put(key, body, contentType);
  }
  await db.update(schema.users).set({ avatarKey: key }).where(eq(schema.users.id, h.user.id));
  await dropQuietly(old);
  return { avatarUrl: avatarUrl(h.user.id, key) };
}

/** Owners and admins set (or with `data` null, remove) the workspace's image. */
export async function setWorkspaceImageAs(h: Human, data: unknown) {
  if (!canManagePeople(h.membership.role)) throw new ServiceError("forbidden", "Only workspace owners and admins can change the workspace image");
  const db = await getDb();
  const [row] = await db.select({ key: schema.workspaces.imageKey }).from(schema.workspaces).where(eq(schema.workspaces.id, h.workspace.id));
  let key: string | null = null;
  if (data !== null) {
    const { body, contentType } = parseUpload(data);
    key = newKey("workspaces", h.workspace.id, contentType);
    await getStorage().put(key, body, contentType);
  }
  await db.update(schema.workspaces).set({ imageKey: key }).where(eq(schema.workspaces.id, h.workspace.id));
  await dropQuietly(row?.key ?? null);
  return { imageUrl: workspaceImageUrl(h.workspace.id, key) };
}

/** A workspace's current image URL, for what shows it. */
export async function workspaceImageOf(workspaceId: string): Promise<string | null> {
  const db = await getDb();
  const [row] = await db.select({ key: schema.workspaces.imageKey }).from(schema.workspaces).where(eq(schema.workspaces.id, workspaceId));
  return workspaceImageUrl(workspaceId, row?.key ?? null);
}

/** The bytes of a picture, if the person may see it: their own workspace's image, or the picture of someone in a workspace they share. */
export async function readImageAs(h: Human, kind: "users" | "workspaces", id: string): Promise<StoredObject> {
  const db = await getDb();
  let key: string | null = null;
  if (kind === "workspaces") {
    if (id === h.workspace.id) key = (await db.select({ key: schema.workspaces.imageKey }).from(schema.workspaces).where(eq(schema.workspaces.id, id)))[0]?.key ?? null;
  } else {
    const [row] = await db
      .select({ key: schema.users.avatarKey })
      .from(schema.users)
      .innerJoin(schema.memberships, eq(schema.memberships.userId, schema.users.id))
      .where(and(eq(schema.users.id, id), eq(schema.memberships.workspaceId, h.workspace.id)));
    key = row?.key ?? null;
  }
  const object = key ? await getStorage().get(key) : null;
  if (!object) throw new ServiceError("not_found", "Image not found");
  return object;
}
