/**
 * Who may read and change a picture, against a real database: your own profile picture and (as an owner or admin) your own
 * workspace's image; a workspace's image is seen only from inside it, a person's picture only by someone who shares a workspace
 * with them. Runs on an in-memory PGlite (`pnpm test`), or a real Postgres with TEST_DATABASE_URL.
 */
if (process.env.TEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
} else {
  process.env.PGLITE_DIR = "memory://";
  delete process.env.DATABASE_URL;
}

import { before, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { getDb, schema } from "../db";
import type { WorkspaceRole } from "../db/schema";
import { hashPassword } from "../modules/auth/passwords";
import { humanFromSession, startSession } from "../modules/auth/auth.legacy";
import type { Human } from "../modules/auth/index";
import { readImageAs, setAvatarAs, setWorkspaceImageAs } from "./images";
import { ServiceError } from "../common/service-error";
import { LocalStorage, setStorage } from "../platform/storage/storage";
import { testApp } from "../test/app";
await testApp();

const RUN = Math.random().toString(16).slice(2, 8);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("picture")]);
const upload = PNG.toString("base64");

let n = 0;
async function person(workspaceId: string, role: WorkspaceRole): Promise<Human> {
  const db = await getDb();
  const [u] = await db.insert(schema.users).values({ email: `${role}-${RUN}-${++n}@example.com`, name: `${role} ${n}`, passwordHash: await hashPassword("pw-pw-pw-pw") }).returning();
  await db.insert(schema.memberships).values({ userId: u.id, workspaceId, role });
  const { token } = await startSession(u.id);
  return (await humanFromSession(token))!;
}

let A: { owner: Human; member: Human };
let B: { owner: Human; member: Human };
const code = (c: string) => (e: unknown) => e instanceof ServiceError && e.code === c;

before(async () => {
  setStorage(new LocalStorage(fs.mkdtempSync(path.join(os.tmpdir(), "wh-images-"))));
  const db = await getDb();
  const [a] = await db.insert(schema.workspaces).values({ name: "Images A" }).returning();
  const [b] = await db.insert(schema.workspaces).values({ name: "Images B" }).returning();
  A = { owner: await person(a.id, "owner"), member: await person(a.id, "member") };
  B = { owner: await person(b.id, "owner"), member: await person(b.id, "member") };
});

describe("the workspace image", () => {
  test("an owner sets it, anyone in the workspace can see it, and no one in another workspace can", async () => {
    const { imageUrl } = await setWorkspaceImageAs(A.owner, upload);
    assert.match(imageUrl!, new RegExp(`^/api/app/images/workspaces/${A.owner.workspace.id}\\?v=`));
    const seen = await readImageAs(A.member, "workspaces", A.owner.workspace.id);
    assert.equal(seen.contentType, "image/png");
    await assert.rejects(readImageAs(B.owner, "workspaces", A.owner.workspace.id), code("not_found"), "another workspace's image");
  });

  test("only owners and admins change it, and only their own workspace's", async () => {
    await assert.rejects(setWorkspaceImageAs(A.member, upload), code("forbidden"));
    await setWorkspaceImageAs(B.owner, upload);
    const db = await getDb();
    const [b] = await db.select({ key: schema.workspaces.imageKey }).from(schema.workspaces).where(eq(schema.workspaces.id, B.owner.workspace.id));
    const [a] = await db.select({ key: schema.workspaces.imageKey }).from(schema.workspaces).where(eq(schema.workspaces.id, A.owner.workspace.id));
    assert.ok(b.key?.startsWith(`workspaces/${B.owner.workspace.id}/`));
    assert.ok(a.key?.startsWith(`workspaces/${A.owner.workspace.id}/`), "A's own image is untouched by B's owner");
  });

  test("removing it clears the key", async () => {
    await setWorkspaceImageAs(B.owner, null);
    await assert.rejects(readImageAs(B.owner, "workspaces", B.owner.workspace.id), code("not_found"));
  });
});

describe("a profile picture", () => {
  test("a person sets their own, and only people who share a workspace with them can see it", async () => {
    await setAvatarAs(A.member, upload);
    assert.equal((await readImageAs(A.owner, "users", A.member.user.id)).contentType, "image/png");
    await assert.rejects(readImageAs(B.owner, "users", A.member.user.id), code("not_found"), "someone who shares no workspace with them");
  });

  test("it changes the caller's own row and no one else's", async () => {
    const db = await getDb();
    await setAvatarAs(A.owner, upload);
    const [other] = await db.select({ key: schema.users.avatarKey }).from(schema.users).where(eq(schema.users.id, B.member.user.id));
    assert.equal(other.key, null, "a person in another workspace is untouched");
  });

  test("a picture that is not a PNG, JPEG, WebP or GIF is refused, whatever it is called", async () => {
    await assert.rejects(setAvatarAs(A.member, `data:image/png;base64,${Buffer.from("<svg onload=alert(1)>").toString("base64")}`), code("invalid"));
    await assert.rejects(setAvatarAs(A.member, ""), code("invalid"));
  });
});
