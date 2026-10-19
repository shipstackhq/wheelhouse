/**
 * One person in several workspaces (ADR-23): the session works in one at a time, can switch, and can join another by an
 * invite sent to the address of the account they already have. Runs against a throwaway in-memory PGlite (`pnpm test`).
 */
if (process.env.TEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
} else {
  process.env.PGLITE_DIR = "memory://";
  delete process.env.DATABASE_URL;
}
process.env.MAX_WORKSPACE_MEMBERS = "100";

import { before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { getDb, schema } from "../db";
import { userWorkspaceSuspended } from "./access";
import { currentMembership, humanFromSession, listWorkspaces, startSession, switchWorkspace } from "./auth-core";
import { acceptInviteAsMember, createInvite, InviteError, InviteFailure, peekInviteAsMember, type Issuer } from "./invites";
import * as svc from "./service";
import * as t from "./workspace-app";

const RUN = Math.random().toString(16).slice(2, 8);
const L = RUN.replace(/[0-9]/g, (c) => "ghijklmnop"[Number(c)]).slice(0, 2).toUpperCase();
let n = 0;
const email = (p: string) => `${p}-${RUN}-${++n}@example.com`;

async function workspace(name: string) {
  const db = await getDb();
  const [row] = await db.insert(schema.workspaces).values({ name }).returning();
  return row;
}
async function user(e: string, name: string) {
  const db = await getDb();
  const [u] = await db.insert(schema.users).values({ email: e, name, passwordHash: "x" }).returning();
  return u;
}
const join = async (userId: string, workspaceId: string, role: "owner" | "admin" | "member" | "viewer" | "guest" = "member") => {
  const db = await getDb();
  await db.insert(schema.memberships).values({ userId, workspaceId, role });
};

let A: { id: string };
let B: { id: string };
let C: { id: string };
let pat: { id: string; email: string }; // in A (first) and B
let token: string;

before(async () => {
  A = await workspace(`Alpha ${RUN}`);
  B = await workspace(`Beta ${RUN}`);
  C = await workspace(`Gamma ${RUN}`);
  pat = await user(email("pat"), "Pat");
  await join(pat.id, A.id, "owner");
  await new Promise((r) => setTimeout(r, 5)); // memberships are ordered by when they were made
  await join(pat.id, B.id, "member");
  token = (await startSession(pat.id)).token;
});

describe("working in one workspace at a time", () => {
  test("a new session starts in the first workspace, and lists both", async () => {
    const h = (await humanFromSession(token))!;
    assert.equal(h.workspace.id, A.id);
    assert.deepEqual((await listWorkspaces(pat.id, null)).map((w) => [w.name, w.role, w.active]), [[`Alpha ${RUN}`, "owner", true], [`Beta ${RUN}`, "member", false]]);
  });

  test("switching changes only this session; the other session is untouched; every actor from it is the other workspace's", async () => {
    const other = (await startSession(pat.id)).token;
    assert.deepEqual(await switchWorkspace(token, pat.id, B.id), { id: B.id, name: `Beta ${RUN}` });
    const mine = (await humanFromSession(token))!;
    assert.equal(mine.workspace.id, B.id);
    assert.equal(mine.membership.role, "member");
    assert.equal(mine.actor.workspaceId, B.id);
    assert.equal((await humanFromSession(other))!.workspace.id, A.id);
    await switchWorkspace(token, pat.id, A.id);
    assert.equal((await humanFromSession(token))!.workspace.id, A.id);
  });

  test("projects belong to the workspace you are in: the other one's are not found", async () => {
    const a = (await humanFromSession(token))!;
    const pa = await svc.createProject(a.actor, { name: "In Alpha", key: `IA${L}` });
    await switchWorkspace(token, pat.id, B.id);
    const b = (await humanFromSession(token))!;
    await assert.rejects(() => svc.getProject(b.actor, pa.key), (e) => e instanceof svc.ServiceError && e.code === "not_found");
    assert.deepEqual(await svc.listProjects(b.actor), []);
    await switchWorkspace(token, pat.id, A.id);
  });

  test("you cannot switch into a workspace you are not in, and nothing changes when you try", async () => {
    assert.equal(await switchWorkspace(token, pat.id, C.id), null);
    assert.equal((await humanFromSession(token))!.workspace.id, A.id);
    const stranger = await user(email("stranger"), "Stranger");
    assert.equal(await switchWorkspace(token, stranger.id, A.id), null); // someone else's session cannot be pointed anywhere
    assert.equal((await humanFromSession(token))!.workspace.id, A.id);
  });

  test("a suspended workspace is not offered or chosen, and only someone with no usable workspace is locked out", async () => {
    const db = await getDb();
    const mix = await user(email("mix"), "Mix");
    await join(mix.id, B.id, "member");
    await new Promise((r) => setTimeout(r, 5));
    await join(mix.id, C.id, "member");
    const tok = (await startSession(mix.id)).token;
    await switchWorkspace(tok, mix.id, B.id);
    await db.update(schema.workspaces).set({ suspendedAt: new Date() }).where(eq(schema.workspaces.id, B.id));
    try {
      assert.equal(await userWorkspaceSuspended(mix.id), false); // still has Gamma
      assert.equal((await humanFromSession(tok))!.workspace.id, C.id); // the session's choice is suspended: falls to a usable one
      assert.deepEqual((await listWorkspaces(mix.id, B.id)).map((w) => w.name), [`Gamma ${RUN}`]);
      assert.equal(await switchWorkspace(tok, mix.id, B.id), null);
      await db.update(schema.workspaces).set({ suspendedAt: new Date() }).where(eq(schema.workspaces.id, C.id));
      assert.equal(await userWorkspaceSuspended(mix.id), true); // now every one is suspended
      assert.equal(await humanFromSession(tok), null);
      assert.equal(await currentMembership(mix.id), null);
    } finally {
      await db.update(schema.workspaces).set({ suspendedAt: null }).where(eq(schema.workspaces.id, B.id));
      await db.update(schema.workspaces).set({ suspendedAt: null }).where(eq(schema.workspaces.id, C.id));
    }
  });
});

describe("joining another workspace with the account you already have", () => {
  const issuer = (workspaceId: string, userId: string): Issuer => ({ userId, email: "owner@example.com", workspaceId, role: "owner" });
  let ownerC: { id: string };
  before(async () => {
    ownerC = await user(email("ownerc"), "Gamma owner");
    await join(ownerC.id, C.id, "owner");
  });

  test("an invite sent to your own address is previewed and accepted: you become a member, with its projects, and keep your account", async () => {
    const actor = { kind: "human" as const, id: ownerC.id, name: "Gamma owner", workspaceId: C.id };
    const proj = await svc.createProject(actor, { name: "Shared", key: `SH${L}` });
    const inv = await createInvite(issuer(C.id, ownerC.id), { kind: "join_workspace", email: pat.email, role: "viewer", projects: [{ project: proj.key, role: "editor" }] });
    // pat is not signed out of anything: the public flow does not apply to an existing account, the signed-in one does
    await assert.rejects(() => import("./invites").then((m) => m.acceptInvite({ token: inv.token, name: "Pat", password: "correct horse battery" })), (e) => e instanceof InviteFailure);
    const peek = await peekInviteAsMember(pat, inv.token);
    assert.deepEqual([peek?.workspaceName, peek?.role, peek?.projects.map((p) => [p.key, p.role])], [`Gamma ${RUN}`, "viewer", [[proj.key, "editor"]]]);
    const { workspaceId } = await acceptInviteAsMember(pat, inv.token);
    assert.equal(workspaceId, C.id);
    assert.deepEqual((await listWorkspaces(pat.id, null)).map((w) => w.name), [`Alpha ${RUN}`, `Beta ${RUN}`, `Gamma ${RUN}`]);
    await switchWorkspace(token, pat.id, C.id);
    const h = (await humanFromSession(token))!;
    assert.equal(h.membership.role, "viewer");
    assert.deepEqual((await svc.listProjects(h.actor)).map((p) => p.key), [proj.key]);
    await assert.rejects(() => acceptInviteAsMember(pat, inv.token), (e) => e instanceof InviteFailure); // used once
    await switchWorkspace(token, pat.id, A.id);
  });

  test("someone else's invite, a bad token, a workspace you are already in and a suspended one all fail without using the invite", async () => {
    const db = await getDb();
    const other = await user(email("other"), "Other");
    const inv = await createInvite(issuer(C.id, ownerC.id), { kind: "join_workspace", email: other.email });
    assert.equal(await peekInviteAsMember(pat, inv.token), null); // addressed to someone else
    await assert.rejects(() => acceptInviteAsMember(pat, inv.token), (e) => e instanceof InviteFailure);
    await assert.rejects(() => acceptInviteAsMember(other, "x".repeat(43)), (e) => e instanceof InviteFailure);

    const again = await createInvite(issuer(C.id, ownerC.id), { kind: "join_workspace", email: pat.email });
    await assert.rejects(() => acceptInviteAsMember(pat, again.token), (e) => e instanceof InviteError && e.code === "conflict"); // already in Gamma
    await db.update(schema.workspaces).set({ suspendedAt: new Date() }).where(eq(schema.workspaces.id, C.id));
    try {
      await assert.rejects(() => acceptInviteAsMember(other, inv.token), (e) => e instanceof InviteFailure);
      assert.equal(await peekInviteAsMember(other, inv.token), null);
    } finally {
      await db.update(schema.workspaces).set({ suspendedAt: null }).where(eq(schema.workspaces.id, C.id));
    }
    assert.ok(await acceptInviteAsMember(other, inv.token)); // never used by the failed tries
  });

  test("the seat limit still holds", async () => {
    process.env.MAX_WORKSPACE_MEMBERS = "1";
    try {
      const x = await user(email("full"), "Full");
      const inv = await createInvite(issuer(B.id, pat.id), { kind: "join_workspace", email: x.email }).catch(() => null);
      assert.equal(inv, null); // the issuer cannot even create one: the workspace is over its limit
    } finally {
      process.env.MAX_WORKSPACE_MEMBERS = "100";
    }
  });

  test("through workspace-app: the signed-in person is moved into the new workspace", async () => {
    const x = await user(email("viaapp"), "Via app");
    await join(x.id, A.id, "member");
    const tok = (await startSession(x.id)).token;
    const inv = await createInvite(issuer(B.id, pat.id), { kind: "join_workspace", email: x.email });
    const h = (await humanFromSession(tok))!;
    assert.equal(h.workspace.id, A.id);
    const peek = await t.peekInviteAsMemberAs(h, inv.token);
    assert.equal(peek.workspaceName, `Beta ${RUN}`);
    const done = await t.acceptInviteAsMemberAs(h, inv.token, tok);
    assert.equal(done.workspace.id, B.id);
    assert.equal((await humanFromSession(tok))!.workspace.id, B.id);
    await assert.rejects(() => t.peekInviteAsMemberAs(h, "nope"), (e) => e instanceof svc.ServiceError && e.code === "invalid");
  });
});
