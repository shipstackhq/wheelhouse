/**
 * Admin workspaces page and workspace suspension (WH-52). Runs against a throwaway in-memory PGlite (`pnpm test`).
 * To run against a real Postgres instead:
 *   TEST_DATABASE_URL=postgres://... npx tsx --conditions=react-server --test --test-force-exit src/lib/workspaces-admin.test.ts
 */
if (process.env.TEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
} else {
  process.env.PGLITE_DIR = "memory://";
  delete process.env.DATABASE_URL;
}
const RUN = Math.random().toString(16).slice(2, 8);
const ADMIN_EMAIL = `admin-${RUN}@example.com`;
process.env.ADMIN_EMAILS = ADMIN_EMAIL;
process.env.MAX_WORKSPACE_MEMBERS = "100";

import crypto from "node:crypto";
import { before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { getDb, schema } from "../db";
import { actorForKey, SuspendedError, WORKSPACE_SUSPENDED_MESSAGE, sha256, userForSessionToken, userWorkspaceSuspended } from "./access";
import { acceptInvite, createInvite, InviteError, InviteFailure, peekInvite, type Issuer } from "./invites";
import { AdminError, getWorkspaceDetail, listWorkspaces, restoreWorkspace, suspendWorkspace, type Admin } from "./workspaces-admin";
import * as svc from "./service";

const PW = "correct horse battery";
let n = 0;
const email = (p: string) => `${p}-${RUN}-${++n}@example.com`;

type Side = { workspaceId: string; name: string; owner: Issuer; member: { userId: string }; key: string; token: string; memberToken: string };
let admin: Admin;
let adminIssuer: Issuer;
let X: Side;
let Y: Side;

async function user(e: string, name: string) {
  const db = await getDb();
  const [u] = await db.insert(schema.users).values({ email: e, name, passwordHash: "x" }).returning();
  return u;
}
async function session(userId: string) {
  const db = await getDb();
  const token = crypto.randomBytes(24).toString("base64url");
  await db.insert(schema.sessions).values({ id: sha256(token), userId, expiresAt: new Date(Date.now() + 864e5) });
  return token;
}
async function side(name: string): Promise<Side> {
  const db = await getDb();
  const [t] = await db.insert(schema.workspaces).values({ name }).returning();
  const o = await user(email("owner"), `${name} owner`);
  const m = await user(email("member"), `${name} member`);
  await db.insert(schema.memberships).values({ userId: o.id, workspaceId: t.id, role: "owner" });
  await db.insert(schema.memberships).values({ userId: m.id, workspaceId: t.id, role: "member" });
  const key = `wh_${crypto.randomBytes(18).toString("base64url")}`;
  await db.insert(schema.apiKeys).values({ workspaceId: t.id, name: `${name} key`, prefix: key.slice(0, 10), keyHash: sha256(key), createdBy: o.id });
  return {
    workspaceId: t.id,
    name,
    owner: { userId: o.id, email: o.email, workspaceId: t.id, role: "owner" },
    member: { userId: m.id },
    key,
    token: await session(o.id),
    memberToken: await session(m.id),
  };
}
const adminError = (p: Promise<unknown>, code: string) => assert.rejects(p, (e: unknown) => e instanceof AdminError && e.code === code);

before(async () => {
  const home = await side(`Home ${RUN}`);
  const a = await user(ADMIN_EMAIL, "Admin");
  const db = await getDb();
  await db.insert(schema.memberships).values({ userId: a.id, workspaceId: home.workspaceId, role: "owner" });
  admin = { userId: a.id, email: ADMIN_EMAIL, workspaceId: home.workspaceId };
  adminIssuer = { userId: a.id, email: ADMIN_EMAIL, workspaceId: home.workspaceId, role: "owner" };
  X = await side(`Acme ${RUN}`);
  Y = await side(`Beta ${RUN}`);
});

describe("who may use the admin functions", () => {
  test("a workspace owner who is not an instance admin is refused by every function", async () => {
    const notAdmin: Admin = { userId: X.owner.userId, email: X.owner.email, workspaceId: X.workspaceId };
    await adminError(listWorkspaces(notAdmin), "forbidden");
    await adminError(getWorkspaceDetail(notAdmin, Y.workspaceId), "forbidden");
    await adminError(suspendWorkspace(notAdmin, Y.workspaceId, { confirmName: Y.name }), "forbidden");
    await adminError(restoreWorkspace(notAdmin, Y.workspaceId), "forbidden");
    assert.equal(await userWorkspaceSuspended(Y.owner.userId), false, "nothing changed");
  });
});

describe("the workspaces list", () => {
  test("shows every workspace with correct counts, owners and the caller's own workspace", async () => {
    await createInvite(X.owner, { kind: "join_workspace", email: email("pend") }); // one pending invite for Acme
    const db = await getDb();
    await db.insert(schema.teams).values({ workspaceId: X.workspaceId, key: "AC", name: "Acme app" });
    const rows = await listWorkspaces(admin);
    const x = rows.find((t) => t.id === X.workspaceId)!;
    assert.deepEqual(
      { members: x.members, pending: x.pendingInvites, used: x.seatsUsed, teams: x.teams, suspended: !!x.suspendedAt, yours: x.isYours },
      { members: 2, pending: 1, used: 3, teams: 1, suspended: false, yours: false },
    );
    assert.deepEqual(x.owners.map((o) => o.email), [X.owner.email]);
    assert.ok(rows.find((t) => t.id === admin.workspaceId)!.isYours);
    assert.ok(rows.some((t) => t.id === Y.workspaceId));
  });

  test("records who invited a workspace that was started from an invite", async () => {
    const inv = await createInvite(adminIssuer, { kind: "new_workspace", email: email("founder"), workspaceName: `Founded ${RUN}` });
    const r = await acceptInvite({ token: inv.token, name: "Founder", password: PW });
    const t = (await listWorkspaces(admin)).find((x) => x.id === r.workspaceId)!;
    assert.deepEqual(t.invitedBy, { name: "Admin", email: ADMIN_EMAIL });
    assert.equal(t.name, `Founded ${RUN}`);
  });

  test("shows no workspace content: an issue's title and a comment never appear on the admin pages", async () => {
    const human = { kind: "human" as const, id: X.owner.userId, name: "o", workspaceId: X.workspaceId };
    await svc.createTeam(human, { name: "Secret team", key: "SEC" });
    const issue = await svc.createIssue(human, "SEC", { title: `TOP-SECRET-TITLE-${RUN}`, body: `TOP-SECRET-BODY-${RUN}` });
    await svc.addComment(human, issue.ref, `TOP-SECRET-COMMENT-${RUN}`);
    const everything = JSON.stringify([await listWorkspaces(admin), await getWorkspaceDetail(admin, X.workspaceId)]);
    assert.ok(!everything.includes("TOP-SECRET"), "metadata only");
    assert.ok(!everything.includes("Secret team"), "not even team names");
  });

  test("the detail lists members, invites with their status, and API keys without the key itself", async () => {
    const d = await getWorkspaceDetail(admin, X.workspaceId);
    assert.deepEqual(d.memberList.map((m) => m.role).sort(), ["member", "owner"]);
    assert.ok(d.inviteList.some((i) => i.status === "pending"));
    assert.equal(d.keys.length, 1);
    assert.ok(d.keys[0].prefix.startsWith("wh_"));
    assert.ok(!JSON.stringify(d).includes(X.key), "the full key is never shown");
    assert.ok(!JSON.stringify(d).includes(sha256(X.key)), "nor its hash");
    await adminError(getWorkspaceDetail(admin, crypto.randomUUID()), "not_found");
  });
});

describe("suspending a workspace", () => {
  let pendingToken: string;
  before(async () => {
    pendingToken = (await createInvite(X.owner, { kind: "join_workspace", email: email("inert") })).token;
  });

  test("refuses the admin's own workspace, an unknown workspace and a wrong confirmation", async () => {
    await adminError(suspendWorkspace(admin, admin.workspaceId, { confirmName: "anything" }), "conflict");
    await adminError(suspendWorkspace(admin, crypto.randomUUID(), { confirmName: "x" }), "not_found");
    await adminError(suspendWorkspace(admin, X.workspaceId, { confirmName: "acme" }), "invalid");
    await adminError(suspendWorkspace(admin, X.workspaceId, { confirmName: "" }), "invalid");
    assert.equal(await userWorkspaceSuspended(X.owner.userId), false, "still active");
  });

  test("signs the workspace out, refuses its logins and its API keys, blocks its invites, and leaves other workspaces alone", async () => {
    assert.ok(await userForSessionToken(X.token), "signed in before");
    assert.ok(await actorForKey(X.key, "1.1.1.1"), "key works before");

    const r = await suspendWorkspace(admin, X.workspaceId, { confirmName: ` ${X.name} `, reason: "  abuse report  " });
    assert.equal(r.sessionsEnded, 2, "both members' sessions were deleted");

    const db = await getDb();
    const [t] = await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, X.workspaceId));
    assert.ok(t.suspendedAt);
    assert.equal(t.suspendedBy, admin.userId);
    assert.equal(t.suspendedReason, "abuse report");

    assert.equal(await userForSessionToken(X.token), null, "the old session is gone");
    assert.equal(await userForSessionToken(X.memberToken), null);
    const fresh = await session(X.owner.userId); // even a session that somehow exists is treated as signed out
    assert.equal(await userForSessionToken(fresh), null);
    assert.equal(await userWorkspaceSuspended(X.owner.userId), true, "so the login action can refuse");
    assert.equal(await userWorkspaceSuspended(X.member.userId), true);

    await assert.rejects(actorForKey(X.key, "1.1.1.1"), (e: unknown) => e instanceof SuspendedError && e.status === 403 && e.message === WORKSPACE_SUSPENDED_MESSAGE);

    await assert.rejects(createInvite(X.owner, { kind: "join_workspace", email: email("blocked") }), (e: unknown) => e instanceof InviteError && e.code === "forbidden");
    assert.equal(await peekInvite(pendingToken), null, "its pending invite looks invalid");
    await assert.rejects(acceptInvite({ token: pendingToken, name: "Nope", password: PW }), (e: unknown) => e instanceof InviteFailure && e.reason === "invalid");

    // workspace Y is untouched
    assert.ok(await userForSessionToken(Y.token));
    assert.ok(await userForSessionToken(Y.memberToken));
    assert.ok(await actorForKey(Y.key, "1.1.1.1"));
    assert.equal(await userWorkspaceSuspended(Y.owner.userId), false);
    const list = await listWorkspaces(admin);
    assert.ok(list.find((x) => x.id === X.workspaceId)!.suspendedAt);
    assert.equal(list.find((x) => x.id === Y.workspaceId)!.suspendedAt, null);
  });

  test("suspending twice is refused, and the data is still there", async () => {
    await adminError(suspendWorkspace(admin, X.workspaceId, { confirmName: X.name }), "conflict");
    const d = await getWorkspaceDetail(admin, X.workspaceId);
    assert.equal(d.memberList.length, 2);
    assert.equal(d.keys.length, 1);
    assert.equal(d.suspendedBy?.email, ADMIN_EMAIL);
    assert.equal(d.suspendedReason, "abuse report");
  });

  test("restoring brings the workspace back as it was: keys, invites and members, but people sign in again", async () => {
    await restoreWorkspace(admin, X.workspaceId);
    assert.equal(await userWorkspaceSuspended(X.owner.userId), false);
    assert.ok(await actorForKey(X.key, "1.1.1.1"), "the same key works again");
    assert.equal(await userForSessionToken(X.token), null, "sessions were ended and are not recreated");
    assert.ok(await userForSessionToken(await session(X.owner.userId)), "a new sign-in works");
    assert.ok(await peekInvite(pendingToken), "the unexpired invite works again");
    const r = await acceptInvite({ token: pendingToken, name: "Joiner", password: PW });
    assert.equal(r.workspaceId, X.workspaceId);
    const d = await getWorkspaceDetail(admin, X.workspaceId);
    assert.equal(d.suspendedAt, null);
    assert.equal(d.suspendedReason, null);
    await adminError(restoreWorkspace(admin, X.workspaceId), "conflict");
  });

  test("a second admin account in another workspace can suspend a workspace that is not theirs", async () => {
    const db = await getDb();
    const otherWorkspace = await side(`Other ${RUN}`);
    const o = await user(email("admin2"), "Admin Two");
    await db.insert(schema.memberships).values({ userId: o.id, workspaceId: otherWorkspace.workspaceId, role: "owner" });
    process.env.ADMIN_EMAILS = `${ADMIN_EMAIL},${o.email}`;
    try {
      const a2: Admin = { userId: o.id, email: o.email, workspaceId: otherWorkspace.workspaceId };
      await suspendWorkspace(a2, Y.workspaceId, { confirmName: Y.name });
      await adminError(suspendWorkspace(a2, otherWorkspace.workspaceId, { confirmName: otherWorkspace.name }), "conflict");
      await restoreWorkspace(a2, Y.workspaceId);
    } finally {
      process.env.ADMIN_EMAILS = ADMIN_EMAIL;
    }
  });
});
