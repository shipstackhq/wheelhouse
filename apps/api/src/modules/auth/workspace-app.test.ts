/**
 * The workspace, agents and invite functions behind the web app's pages (WH-95), against a throwaway in-memory PGlite.
 * To use a real Postgres: TEST_DATABASE_URL=postgres://... npx tsx --test --test-force-exit src/modules/auth/workspace-app.test.ts
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

import { before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { getDb, schema } from "../../db";
import type { WorkspaceRole } from "../../db/schema";
import { AccountError, AdminError, InviteError, InviteFailure } from "./auth-errors";
import { appFailure } from "../../lib/api-errors";
import { hashPassword } from "./passwords";
import { humanFromSession, startSession } from "./auth.legacy";
import type { Human } from "./sessions.service";
import { parseTags } from "./auth.rules";
import { ServiceError } from "../../common/service-error";
import * as t from "./auth.legacy";
import { testApp } from "../../test/app";
await testApp();

const PW = "correct horse battery";
let n = 0;
const email = (p: string) => `${p}-${RUN}-${++n}@example.com`;

async function person(workspaceId: string, role: WorkspaceRole, e = email(role)): Promise<Human> {
  const db = await getDb();
  const [u] = await db.insert(schema.users).values({ email: e, name: `${role} ${n}`, passwordHash: await hashPassword(PW) }).returning();
  await db.insert(schema.memberships).values({ userId: u.id, workspaceId, role });
  const { token } = await startSession(u.id);
  return (await humanFromSession(token))!;
}
async function workspace(name: string) {
  const db = await getDb();
  const [row] = await db.insert(schema.workspaces).values({ name }).returning();
  return row;
}

let A: { workspace: { id: string }; owner: Human; member: Human };
let B: { workspace: { id: string }; owner: Human; member: Human };
let admin: Human;

before(async () => {
  const a = await workspace("Workspace A");
  const b = await workspace("Workspace B");
  A = { workspace: a, owner: await person(a.id, "owner"), member: await person(a.id, "member") };
  B = { workspace: b, owner: await person(b.id, "owner"), member: await person(b.id, "member") };
  admin = await person(A.workspace.id, "owner", ADMIN_EMAIL);
});

const rejects = async (p: Promise<unknown>, check: (e: unknown) => boolean, what: string) => {
  try {
    await p;
  } catch (e) {
    assert.ok(check(e), `${what}: wrong error ${String(e)}`);
    return e;
  }
  assert.fail(`${what}: expected an error`);
};
const isService = (code: ServiceError["code"]) => (e: unknown) => e instanceof ServiceError && e.code === code;

describe("parseTags", () => {
  test("lower-cases, trims and drops empties, from a string or a list", () => {
    assert.deepEqual(parseTags(" Backend, design ,,PM "), ["backend", "design", "pm"]);
    assert.deepEqual(parseTags(["Eng", " Lead "]), ["eng", "lead"]);
    assert.deepEqual(parseTags(undefined), []);
    assert.deepEqual(parseTags(42), []);
  });
});

describe("the workspace page", () => {
  test("lists this workspace's members only, with seats, and shows pending invites to owners only", async () => {
    await t.createInviteAs(A.owner, { kind: "join_workspace", email: email("pending") }, "http://x");
    const o = await t.workspaceOverview(A.owner);
    assert.equal(o.workspace.id, A.workspace.id);
    assert.ok(o.members.every((m) => [A.owner, A.member, admin].some((h) => h.user.id === m.userId)), "nobody from workspace B");
    assert.ok(!o.members.some((m) => m.userId === B.owner.user.id));
    assert.equal(o.seats.max, 100);
    assert.equal(o.pendingInvites.length, 1);
    assert.equal((await t.workspaceOverview(A.member)).pendingInvites.length, 0, "a member does not see invites");
    assert.ok(!JSON.stringify(o).includes("passwordHash"));
  });
});

describe("changing members", () => {
  test("an owner changes role and tags; the tags are normalised", async () => {
    const m = await t.updateMemberAs(A.owner, { userId: A.member.user.id, role: "member", tags: "Backend, Lead" });
    assert.deepEqual(m.tags, ["backend", "lead"]);
    assert.equal(m.role, "member");
  });
  test("a member may not", async () => {
    await rejects(t.updateMemberAs(A.member, { userId: A.owner.user.id, role: "member", tags: [] }), isService("forbidden"), "member update");
    await rejects(t.removeMemberAs(A.member, A.owner.user.id), isService("forbidden"), "member remove");
  });
  test("a person from another workspace is simply not found, and nothing changes", async () => {
    await rejects(t.updateMemberAs(A.owner, { userId: B.member.user.id, role: "owner", tags: ["x"] }), isService("not_found"), "cross-workspace update");
    await rejects(t.removeMemberAs(A.owner, B.member.user.id), isService("not_found"), "cross-workspace remove");
    const db = await getDb();
    const [m] = await db.select().from(schema.memberships).where(eq(schema.memberships.userId, B.member.user.id));
    assert.equal(m.role, "member");
    assert.deepEqual(m.tags, []);
  });
  test("the only owner cannot be demoted or remove themselves", async () => {
    const solo = await workspace("Solo");
    const o = await person(solo.id, "owner");
    await rejects(t.updateMemberAs(o, { userId: o.user.id, role: "member", tags: [] }), isService("conflict"), "demote last owner");
    await rejects(t.removeMemberAs(o, o.user.id), isService("invalid"), "remove self");
  });
  test("a bad role is a field error", async () => {
    const e = (await rejects(t.updateMemberAs(A.owner, { userId: A.member.user.id, role: "root", tags: [] }), isService("invalid"), "bad role")) as ServiceError;
    assert.deepEqual(e.details, { fields: { role: "Choose a role" } });
  });
  test("an admin manages members and invites, but only an owner can make, change or remove an owner", async () => {
    const adm = await person(A.workspace.id, "admin");
    const target = await person(A.workspace.id, "member");
    const changed = await t.updateMemberAs(adm, { userId: target.user.id, role: "viewer", tags: [] });
    assert.equal(changed.role, "viewer");
    await rejects(t.updateMemberAs(adm, { userId: target.user.id, role: "owner", tags: [] }), isService("forbidden"), "admin makes an owner");
    await rejects(t.updateMemberAs(adm, { userId: A.owner.user.id, role: "member", tags: [] }), isService("forbidden"), "admin demotes an owner");
    await rejects(t.removeMemberAs(adm, A.owner.user.id), isService("forbidden"), "admin removes an owner");
    const inv = await t.createInviteAs(adm, { kind: "join_workspace", email: email("new"), role: "guest" }, "https://wh.test");
    assert.equal(inv.kind, "join_workspace");
    await rejects(t.createInviteAs(adm, { kind: "join_workspace", email: email("new"), role: "owner" }, "https://wh.test"), (e) => e instanceof InviteError && e.code === "forbidden", "admin invites an owner");
    assert.deepEqual(await t.removeMemberAs(adm, target.user.id), { ok: true });
  });
  test("a member, viewer or guest cannot manage people", async () => {
    for (const role of ["member", "viewer", "guest"] as const) {
      const p = await person(A.workspace.id, role);
      await rejects(t.updateMemberAs(p, { userId: A.member.user.id, role: "viewer", tags: [] }), isService("forbidden"), `${role} changes a role`);
      await rejects(t.createInviteAs(p, { kind: "join_workspace", email: email("x"), role: "member" }, "https://wh.test"), (e) => e instanceof InviteError && e.code === "forbidden", `${role} invites`);
    }
  });
  test("an owner removes a member of their own workspace", async () => {
    const extra = await person(A.workspace.id, "member");
    assert.deepEqual(await t.removeMemberAs(A.owner, extra.user.id), { ok: true });
    assert.ok(!(await t.workspaceOverview(A.owner)).members.some((m) => m.userId === extra.user.id));
  });
});

describe("changing your password", () => {
  test("needs the current one and a strong new one, and then the new one works", async () => {
    const p = await person(A.workspace.id, "member");
    const wrong = (await rejects(t.changePasswordAs(p, { current: "nope nope nope", next: "another long passphrase" }), isService("invalid"), "wrong current")) as ServiceError;
    assert.equal(wrong.message, "Current password is wrong");
    assert.deepEqual(wrong.details, { fields: { current: "Current password is wrong" } });
    await rejects(t.changePasswordAs(p, { current: PW, next: "short" }), isService("invalid"), "weak");
    assert.deepEqual(await t.changePasswordAs(p, { current: PW, next: "another long passphrase" }), { ok: true });
    const db = await getDb();
    const [u] = await db.select().from(schema.users).where(eq(schema.users.id, p.user.id));
    const { verifyPassword } = await import("./passwords");
    assert.ok(await verifyPassword("another long passphrase", u.passwordHash));
    assert.ok(!(await verifyPassword(PW, u.passwordHash)));
  });
});

describe("API keys", () => {
  test("the secret is returned once at creation, and never by the listing", async () => {
    const { key, secret } = await t.createKeyAs(A.owner, "  CI bot ");
    assert.match(secret, /^wh_/);
    assert.equal(key.name, "CI bot");
    assert.equal(key.prefix, secret.slice(0, 10));
    const listing = JSON.stringify(await t.listKeys(A.owner));
    assert.ok(!listing.includes(secret) && !listing.includes("keyHash"), "no secret and no hash in a listing");
    assert.ok(JSON.stringify(key).indexOf(secret) < 0);
  });
  test("a blank name gets a default", async () => {
    assert.equal((await t.createKeyAs(A.member, "   ")).key.name, "Claude agent");
  });
  test("creation is limited to ten an hour per person", async () => {
    const p = await person(A.workspace.id, "member");
    for (let i = 0; i < 10; i++) await t.createKeyAs(p, `k${i}`);
    const e = (await rejects(t.createKeyAs(p, "one too many"), (x) => x instanceof AccountError && x.code === "rate_limited", "key limit")) as AccountError;
    assert.ok((e.retryAfter ?? 0) > 0);
  });
  test("the listing is this workspace's keys only", async () => {
    const mine = await t.createKeyAs(B.owner, "B key");
    assert.ok(!(await t.listKeys(A.owner)).some((k) => k.id === mine.key.id));
    assert.ok((await t.listKeys(B.owner)).some((k) => k.id === mine.key.id));
  });
  test("another workspace's key cannot be revoked or have its capability changed: not found, nothing changes", async () => {
    const theirs = (await t.createKeyAs(B.owner, "theirs")).key;
    await rejects(t.revokeKeyAs(A.owner, theirs.id), isService("not_found"), "cross-workspace revoke");
    await rejects(t.setKeyDocsWriteAs(A.owner, theirs.id, true), isService("not_found"), "cross-workspace capability");
    const after = (await t.listKeys(B.owner)).find((k) => k.id === theirs.id)!;
    assert.equal(after.revokedAt, null);
    assert.equal(after.canWriteDocs, false);
  });
  test("docs:write can be granted and taken away, and a key can be revoked", async () => {
    const { key } = await t.createKeyAs(A.owner, "writer");
    assert.equal((await t.setKeyDocsWriteAs(A.owner, key.id, true)).canWriteDocs, true);
    assert.equal((await t.setKeyDocsWriteAs(A.owner, key.id, false)).canWriteDocs, false);
    assert.deepEqual(await t.revokeKeyAs(A.owner, key.id), { ok: true });
    assert.ok((await t.listKeys(A.owner)).find((k) => k.id === key.id)!.revokedAt);
  });
  test("the Agents page carries commands with the server's address, and no key in them", async () => {
    const page = await t.agentsPage(A.owner, "https://wh.example.test/");
    assert.equal(page.setup.url, "https://wh.example.test");
    assert.ok(page.setup.mcp.includes("https://wh.example.test/mcp"));
    assert.ok(!JSON.stringify(page.setup).includes("wh_"), "no key value in any command");
  });
});

describe("invites", () => {
  test("an owner gets a one-time link with the token in the fragment", async () => {
    const r = await t.createInviteAs(A.owner, { kind: "join_workspace", email: email("new"), role: "member", tags: "design" }, "https://wh.example.test/");
    assert.match(r.link, /^https:\/\/wh\.example\.test\/invite#[A-Za-z0-9_-]{43}$/);
    const listed = await t.pendingInvites(A.owner, "join_workspace");
    assert.ok(listed.some((i) => i.id === r.id));
    assert.ok(!JSON.stringify(listed).includes(r.link.split("#")[1]), "the link is never shown again");
  });
  test("a member cannot invite; only an instance admin starts a new workspace", async () => {
    await rejects(t.createInviteAs(A.member, { kind: "join_workspace", email: email("x") }, "http://x"), (e) => e instanceof InviteError && e.code === "forbidden", "member invite");
    await rejects(t.createInviteAs(A.owner, { kind: "new_workspace", email: email("x") }, "http://x"), (e) => e instanceof InviteError && e.code === "forbidden", "owner new_workspace");
    const r = await t.createInviteAs(admin, { kind: "new_workspace", email: email("founder"), workspace: "Founders" }, "http://x");
    assert.equal(r.kind, "new_workspace");
    assert.ok((await t.pendingInvites(admin, "new_workspace")).some((i) => i.id === r.id));
  });
  test("invites are scoped to the workspace: another workspace's owner sees and revokes nothing of ours", async () => {
    const mine = await t.createInviteAs(A.owner, { kind: "join_workspace", email: email("scoped") }, "http://x");
    assert.ok(!(await t.pendingInvites(B.owner, "join_workspace")).some((i) => i.id === mine.id));
    await rejects(t.revokeInviteAs(B.owner, mine.id), (e) => e instanceof InviteError && e.code === "not_found", "cross-workspace revoke");
    assert.deepEqual(await t.revokeInviteAs(A.owner, mine.id), { ok: true });
  });
  test("creation is limited to twenty an hour per person", async () => {
    const s = await workspace("Limits");
    const o = await person(s.id, "owner");
    let last: unknown;
    for (let i = 0; i < 21; i++) {
      try {
        await t.createInviteAs(o, { kind: "join_workspace", email: email("lim") }, "http://x");
      } catch (e) {
        last = e;
      }
    }
    assert.ok(last instanceof AccountError && last.code === "rate_limited" || last instanceof InviteError, "the limit or the seats stop it");
  });
  test("peeking tells nothing about why a link is bad, and is limited per address", async () => {
    const r = await t.createInviteAs(A.owner, { kind: "join_workspace", email: email("peek") }, "http://x");
    const token = r.link.split("#")[1];
    const peeked = await t.peekInviteAs(token, "10.0.0.1");
    assert.equal(peeked.kind, "join_workspace");
    assert.equal(peeked.workspaceName, "Workspace A");
    for (const bad of ["", "short", "A".repeat(43)]) {
      const e = (await rejects(t.peekInviteAs(bad, "10.0.0.2"), isService("invalid"), "bad link")) as ServiceError;
      assert.equal(e.message, "This invite link is invalid or has expired.");
    }
    let limited: unknown;
    for (let i = 0; i < 40; i++) limited = await t.peekInviteAs("x", "10.0.0.3").catch((e) => e);
    assert.ok(limited instanceof AccountError && limited.code === "rate_limited");
  });
  test("accepting needs the two passwords to match, then creates the account in the inviting workspace", async () => {
    const r = await t.createInviteAs(A.owner, { kind: "join_workspace", email: email("accept"), role: "member" }, "http://x");
    const token = r.link.split("#")[1];
    await rejects(t.acceptInviteAs({ token, name: "Newbie", password: "a long enough passphrase", confirm: "different" }, "10.0.1.1"), isService("invalid"), "mismatch");
    const { userId } = await t.acceptInviteAs({ token, name: "Newbie", password: "a long enough passphrase", confirm: "a long enough passphrase" }, "10.0.1.1");
    const db = await getDb();
    const [m] = await db.select().from(schema.memberships).where(eq(schema.memberships.userId, userId));
    assert.equal(m.workspaceId, A.workspace.id);
    await rejects(t.acceptInviteAs({ token, name: "Again", password: "a long enough passphrase", confirm: "a long enough passphrase" }, "10.0.1.1"), (e) => e instanceof InviteFailure, "second use");
  });
});

describe("how these failures are answered over HTTP", () => {
  test("invite, admin and account errors keep their code and message; a bad link never says why", () => {
    const cases: [unknown, number, string][] = [
      [new InviteError("forbidden", "Only workspace owners can invite members"), 403, "forbidden"],
      [new InviteError("not_found", "gone"), 404, "not_found"],
      [new InviteError("conflict", "dup"), 409, "conflict"],
      [new InviteError("workspace_full", "full"), 409, "conflict"],
      [new InviteError("invalid", "email"), 400, "invalid"],
      [new InviteError("weak_password", "too short"), 400, "invalid"],
      [new InviteFailure("workspace_full"), 400, "invalid"],
      [new AdminError("forbidden", "no"), 403, "forbidden"],
      [new AdminError("not_found", "no workspace"), 404, "not_found"],
      [new AdminError("conflict", "already"), 409, "conflict"],
      [new AdminError("invalid", "type the name"), 400, "invalid"],
    ];
    for (const [err, status, code] of cases) {
      const f = appFailure(err);
      assert.equal(f.status, status);
      assert.equal((f.body as { error: { code: string } }).error.code, code);
    }
    const weak = appFailure(new InviteError("weak_password", "too short")).body as { error: { details: unknown } };
    assert.deepEqual(weak.error.details, { fields: { password: "too short" } });
    for (const reason of ["invalid", "workspace_full", "account_exists"] as const) {
      assert.equal((appFailure(new InviteFailure(reason)).body as { error: { message: string } }).error.message, "This invite link is invalid or has expired.");
    }
  });
});
