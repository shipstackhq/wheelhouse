/**
 * Invite-only signup (WH-49). Runs against a throwaway in-memory PGlite:
 *   pnpm test
 * The concurrency tests only prove row locking on a real Postgres (PGlite has one connection), so
 * they can also run against one:
 *   TEST_DATABASE_URL=postgres://... npx tsx --conditions=react-server --test --test-force-exit src/lib/invites.test.ts
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
delete process.env.MAX_WORKSPACE_MEMBERS;
delete process.env.INVITE_TTL_HOURS;

import crypto from "node:crypto";
import { beforeEach, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { getDb, schema } from "../apps/api/src/db";
import {
  acceptInvite,
  createInvite,
  InviteError,
  InviteFailure,
  listInvites,
  peekInvite,
  revokeInvite,
  seatInfo,
  type Issuer,
} from "../apps/api/src/modules/auth/invites";

const PW = "correct horse battery"; // 21 chars
const run = RUN;
let n = 0;
const email = (p: string) => `${p}-${run}-${++n}@example.com`;
const daysAgo = (d: number) => new Date(Date.now() - d * 864e5);

let workspaceA: string;
let workspaceB: string;
let ownerA: Issuer;
let ownerB: Issuer;
let memberA: Issuer;
let admin: Issuer;

async function user(e: string, name = "U") {
  const db = await getDb();
  const [u] = await db.insert(schema.users).values({ email: e, name, passwordHash: "x" }).returning();
  return u;
}
async function workspace(name: string) {
  const db = await getDb();
  const [t] = await db.insert(schema.workspaces).values({ name }).returning();
  return t.id;
}
async function join(userId: string, workspaceId: string, role: "owner" | "member" = "member") {
  const db = await getDb();
  await db.insert(schema.memberships).values({ userId, workspaceId, role });
}
async function issuerFor(workspaceId: string, role: "owner" | "member", e: string): Promise<Issuer> {
  const u = await user(e);
  await join(u.id, workspaceId, role);
  return { userId: u.id, email: e, workspaceId, role };
}
/** A workspace with the given number of members (the first is an owner). */
async function fullWorkspace(members: number) {
  const t = await workspace(`Workspace ${++n}`);
  const owner = await issuerFor(t, "owner", email("o"));
  for (let i = 1; i < members; i++) await join((await user(email("m"))).id, t);
  return { workspaceId: t, owner };
}
const failure = async (p: Promise<unknown>, reason?: string) => {
  await assert.rejects(p, (e: unknown) => {
    assert.ok(e instanceof InviteFailure, `expected InviteFailure, got ${e}`);
    if (reason) assert.equal(e.reason, reason);
    assert.equal(e.message, "This invite link is invalid or has expired.", "failures read the same to the caller");
    return true;
  });
};
const issueError = async (p: Promise<unknown>, code: string) =>
  assert.rejects(p, (e: unknown) => e instanceof InviteError && e.code === code);
const accept = (token: string, extra: { name?: string; password?: string } = {}) =>
  acceptInvite({ token, name: extra.name ?? "Invited", password: extra.password ?? PW });

before(async () => {
  workspaceA = await workspace("Workspace A");
  workspaceB = await workspace("Workspace B");
  ownerA = await issuerFor(workspaceA, "owner", email("ownerA"));
  memberA = await issuerFor(workspaceA, "member", email("memberA"));
  ownerB = await issuerFor(workspaceB, "owner", email("ownerB"));
  const adminWorkspace = await workspace("Admin workspace");
  admin = await issuerFor(adminWorkspace, "owner", ADMIN_EMAIL);
});

// Most tests keep adding people to the same workspaces, so give them room; the seat-limit tests use the default.
beforeEach(() => {
  process.env.MAX_WORKSPACE_MEMBERS = "100";
});

describe("tokens", () => {
  test("only a hash is stored: the plain token appears nowhere in the database row", async () => {
    const inv = await createInvite(ownerA, { kind: "join_workspace", email: email("h") });
    const db = await getDb();
    const [row] = await db.select().from(schema.invites).where(eq(schema.invites.id, inv.id));
    assert.equal(row.tokenHash, crypto.createHash("sha256").update(inv.token).digest("hex"));
    assert.ok(!JSON.stringify(row).includes(inv.token));
    assert.match(inv.token, /^[A-Za-z0-9_-]{43}$/, "32 random bytes, base64url");
    await revokeInvite(ownerA, inv.id);
  });

  test("every invite gets a different token", async () => {
    const a = await createInvite(ownerA, { kind: "join_workspace", email: email("t1") });
    const b = await createInvite(ownerA, { kind: "join_workspace", email: email("t2") });
    assert.notEqual(a.token, b.token);
    await revokeInvite(ownerA, a.id);
    await revokeInvite(ownerA, b.id);
  });
});

describe("accepting a join invite", () => {
  test("creates the account, with the invited email, role and tags, in the inviter's workspace only", async () => {
    const e = email("join");
    const inv = await createInvite(ownerA, { kind: "join_workspace", email: e.toUpperCase(), role: "member", tags: ["Backend ", "design"] });
    const r = await accept(inv.token, { name: "Joiner" });
    assert.equal(r.workspaceId, workspaceA);
    const db = await getDb();
    const [u] = await db.select().from(schema.users).where(eq(schema.users.id, r.userId));
    assert.equal(u.email, e.toLowerCase(), "the stored (lower-cased) email is used");
    assert.equal(u.name, "Joiner");
    const ms = await db.select().from(schema.memberships).where(eq(schema.memberships.userId, r.userId));
    assert.equal(ms.length, 1, "joined exactly one workspace");
    assert.equal(ms[0].workspaceId, workspaceA, "not workspace B");
    assert.equal(ms[0].role, "member");
    assert.deepEqual(ms[0].tags, ["backend", "design"]);
    const [row] = await db.select().from(schema.invites).where(eq(schema.invites.id, inv.id));
    assert.ok(row.usedAt && row.usedBy === r.userId, "the invite records who used it");
  });

  test("the client cannot choose email, workspace, kind or role: extra fields are ignored", async () => {
    const e = email("forced");
    const inv = await createInvite(ownerA, { kind: "join_workspace", email: e, role: "member" });
    const hostile = { token: inv.token, name: "X", password: PW, email: "attacker@example.com", workspaceId: workspaceB, role: "owner", kind: "new_workspace" };
    const r = await acceptInvite(hostile as never);
    const db = await getDb();
    const [u] = await db.select().from(schema.users).where(eq(schema.users.id, r.userId));
    const [m] = await db.select().from(schema.memberships).where(eq(schema.memberships.userId, r.userId));
    assert.equal(u.email, e);
    assert.equal(m.workspaceId, workspaceA);
    assert.equal(m.role, "member");
  });

  test("a link works once", async () => {
    const inv = await createInvite(ownerA, { kind: "join_workspace", email: email("once") });
    await accept(inv.token);
    await failure(accept(inv.token), "invalid");
  });

  test("expired, revoked, unknown and malformed links are all refused alike", async () => {
    const old = await createInvite(ownerA, { kind: "join_workspace", email: email("old") }, daysAgo(30));
    await failure(accept(old.token), "invalid");

    const revoked = await createInvite(ownerA, { kind: "join_workspace", email: email("rev") });
    await revokeInvite(ownerA, revoked.id);
    await failure(accept(revoked.token), "invalid");

    await failure(accept(crypto.randomBytes(32).toString("base64url")), "invalid");
    await failure(accept("short"), "invalid");
    await failure(accept("x".repeat(500)), "invalid");
  });

  test("a weak password or empty name is refused without using the invite", async () => {
    const inv = await createInvite(ownerA, { kind: "join_workspace", email: email("weak") });
    await issueError(accept(inv.token, { password: "short" }), "weak_password");
    await issueError(accept(inv.token, { password: "é".repeat(40) }), "weak_password"); // 80 bytes: bcrypt would truncate
    await issueError(accept(inv.token, { name: "   " }), "invalid");
    assert.ok(await peekInvite(inv.token), "still pending");
    await accept(inv.token);
  });

  test("an email that became an account after the invite was issued is refused and the invite stays pending", async () => {
    const e = email("late");
    const inv = await createInvite(ownerA, { kind: "join_workspace", email: e });
    await user(e);
    await failure(accept(inv.token), "account_exists");
    const db = await getDb();
    const [row] = await db.select().from(schema.invites).where(eq(schema.invites.id, inv.id));
    assert.equal(row.usedAt, null, "rolled back with the failed account");
  });

  test("peek shows the invite to its holder, and nothing for any bad link", async () => {
    const e = email("peek");
    const inv = await createInvite(ownerA, { kind: "join_workspace", email: e });
    assert.deepEqual(await peekInvite(inv.token), { email: e, kind: "join_workspace", workspaceName: "Workspace A" });
    assert.equal(await peekInvite("nope"), null);
    await accept(inv.token);
    assert.equal(await peekInvite(inv.token), null, "used");
    const old = await createInvite(ownerA, { kind: "join_workspace", email: email("peek2") }, daysAgo(30));
    assert.equal(await peekInvite(old.token), null, "expired");
  });
});

describe("who may invite", () => {
  test("only an instance admin can start a new workspace", async () => {
    await issueError(createInvite(ownerA, { kind: "new_workspace", email: email("nt") }), "forbidden");
    await issueError(createInvite(memberA, { kind: "new_workspace", email: email("nt") }), "forbidden");
  });

  test("a plain member cannot invite into the workspace", async () => {
    await issueError(createInvite(memberA, { kind: "join_workspace", email: email("nm") }), "forbidden");
  });

  test("a join invite is for the issuer's own workspace: the owner of B cannot touch A's invites", async () => {
    const inv = await createInvite(ownerA, { kind: "join_workspace", email: email("scoped") });
    assert.ok((await listInvites(ownerA)).some((i) => i.id === inv.id));
    assert.ok(!(await listInvites(ownerB)).some((i) => i.id === inv.id), "B does not see A's invites");
    await issueError(revokeInvite(ownerB, inv.id), "not_found");
    assert.ok(await peekInvite(inv.token), "still pending");
    await revokeInvite(ownerA, inv.id);
  });

  test("the owner role can be granted only by an owner, and only the stored role is applied", async () => {
    const inv = await createInvite(ownerA, { kind: "join_workspace", email: email("ownr"), role: "owner" });
    const r = await accept(inv.token);
    const db = await getDb();
    const [m] = await db.select().from(schema.memberships).where(eq(schema.memberships.userId, r.userId));
    assert.equal(m.role, "owner");
  });

  test("a workspace owner cannot find out whether an email already has an account; only an admin can", async () => {
    const e = email("exists");
    await user(e);
    // Same answer as for an address nobody has used: the invite is created, and the link just never works.
    const inv = await createInvite(ownerA, { kind: "join_workspace", email: e });
    assert.equal(await peekInvite(inv.token), null, "the link shows nothing");
    await failure(accept(inv.token), "account_exists");
    await issueError(createInvite(admin, { kind: "new_workspace", email: e }), "conflict");
  });

  test("a second pending invite for the same email is refused until the first is revoked", async () => {
    const e = email("dup");
    const a = await createInvite(ownerA, { kind: "join_workspace", email: e });
    await issueError(createInvite(ownerA, { kind: "join_workspace", email: e }), "conflict");
    await revokeInvite(ownerA, a.id);
    await createInvite(ownerA, { kind: "join_workspace", email: e });
  });

  test("bad emails are refused", async () => {
    await issueError(createInvite(ownerA, { kind: "join_workspace", email: "not-an-email" }), "invalid");
  });
});

describe("new workspace invites", () => {
  test("the invitee gets a fresh workspace that they own, named as the admin said", async () => {
    const e = email("newteam");
    const inv = await createInvite(admin, { kind: "new_workspace", email: e, workspaceName: "Acme" });
    assert.deepEqual(await peekInvite(inv.token), { email: e, kind: "new_workspace", workspaceName: "Acme" });
    const r = await accept(inv.token, { name: "Founder" });
    assert.notEqual(r.workspaceId, workspaceA);
    assert.notEqual(r.workspaceId, admin.workspaceId);
    const db = await getDb();
    const [t] = await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, r.workspaceId));
    assert.equal(t.name, "Acme");
    const ms = await db.select().from(schema.memberships).where(eq(schema.memberships.workspaceId, r.workspaceId));
    assert.equal(ms.length, 1);
    assert.equal(ms[0].role, "owner");
  });

  test("without a workspace name the workspace is named after the person", async () => {
    const inv = await createInvite(admin, { kind: "new_workspace", email: email("noname") });
    const r = await accept(inv.token, { name: "Sam" });
    const db = await getDb();
    const [t] = await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, r.workspaceId));
    assert.equal(t.name, "Sam's workspace");
  });

  test("workspace owners do not see or revoke new-workspace invites; the admin does", async () => {
    const inv = await createInvite(admin, { kind: "new_workspace", email: email("adm") });
    assert.ok(!(await listInvites(ownerA)).some((i) => i.id === inv.id));
    await issueError(revokeInvite(ownerA, inv.id), "not_found");
    assert.ok((await listInvites(admin)).some((i) => i.id === inv.id));
    await revokeInvite(admin, inv.id);
    await failure(accept(inv.token), "invalid");
  });

  test("they ignore the seat limit, even when the admin's own workspace is full", async () => {
    process.env.MAX_WORKSPACE_MEMBERS = "1";
    const inv = await createInvite(admin, { kind: "new_workspace", email: email("nolimit") });
    await accept(inv.token);
  });
});

describe("the seat limit", () => {
  beforeEach(() => {
    delete process.env.MAX_WORKSPACE_MEMBERS;
  });

  test("five seats by default: the fifth person can be invited, the sixth cannot, and pending invites count", async () => {
    const { workspaceId, owner } = await fullWorkspace(1);
    const made = [];
    for (let i = 0; i < 4; i++) made.push(await createInvite(owner, { kind: "join_workspace", email: email("s") }));
    assert.deepEqual(
      { ...(await seatInfo(workspaceId)) },
      { members: 1, pending: 4, used: 5, max: 5, full: true },
    );
    await issueError(createInvite(owner, { kind: "join_workspace", email: email("s6") }), "workspace_full");
    assert.ok(made.length === 4);
  });

  test("revoking an invite, an expiring invite and removing a member each free a seat", async () => {
    const { workspaceId, owner } = await fullWorkspace(3);
    const a = await createInvite(owner, { kind: "join_workspace", email: email("f") });
    const old = await createInvite(owner, { kind: "join_workspace", email: email("g") }, daysAgo(30));
    assert.equal((await seatInfo(workspaceId)).used, 4, "the expired invite does not count");
    await createInvite(owner, { kind: "join_workspace", email: email("h") });
    await issueError(createInvite(owner, { kind: "join_workspace", email: email("i") }), "workspace_full");

    await revokeInvite(owner, a.id);
    const b = await createInvite(owner, { kind: "join_workspace", email: email("j") });
    await issueError(createInvite(owner, { kind: "join_workspace", email: email("k") }), "workspace_full");

    const db = await getDb();
    const [victim] = await db.select().from(schema.memberships).where(eq(schema.memberships.workspaceId, workspaceId)).limit(3);
    const members = await db.select().from(schema.memberships).where(eq(schema.memberships.workspaceId, workspaceId));
    const removable = members.find((m) => m.userId !== owner.userId)!;
    await db.delete(schema.memberships).where(eq(schema.memberships.userId, removable.userId));
    await createInvite(owner, { kind: "join_workspace", email: email("l") });
    assert.ok(victim && old && b);
  });

  test("MAX_WORKSPACE_MEMBERS is respected", async () => {
    process.env.MAX_WORKSPACE_MEMBERS = "2";
    const { owner } = await fullWorkspace(1);
    await createInvite(owner, { kind: "join_workspace", email: email("c1") });
    await issueError(createInvite(owner, { kind: "join_workspace", email: email("c2") }), "workspace_full");
    process.env.MAX_WORKSPACE_MEMBERS = "not a number";
    assert.equal((await seatInfo(owner.workspaceId)).max, 5, "falls back to the default");
  });

  test("a workspace that is already over the limit cannot add anyone, and is not shrunk", async () => {
    const { workspaceId, owner } = await fullWorkspace(7);
    await issueError(createInvite(owner, { kind: "join_workspace", email: email("over") }), "workspace_full");
    const db = await getDb();
    const ms = await db.select().from(schema.memberships).where(eq(schema.memberships.workspaceId, workspaceId));
    assert.equal(ms.length, 7);
  });

  test("at acceptance a full workspace refuses, and the invite stays pending for when a seat frees up", async () => {
    const { workspaceId, owner } = await fullWorkspace(3);
    const inv = await createInvite(owner, { kind: "join_workspace", email: email("late") });
    await join((await user(email("sneak1"))).id, workspaceId);
    await join((await user(email("sneak2"))).id, workspaceId); // seats taken behind the invite's back: 5 members
    await failure(accept(inv.token), "workspace_full");
    assert.ok(await peekInvite(inv.token), "the invite was not consumed");
    const db = await getDb();
    const ms = await db.select().from(schema.memberships).where(eq(schema.memberships.workspaceId, workspaceId));
    await db.delete(schema.memberships).where(eq(schema.memberships.userId, ms.find((m) => m.userId !== owner.userId)!.userId));
    await accept(inv.token);
  });
});

describe("races", () => {
  test("simultaneous accepts of one link create exactly one account", async () => {
    const e = email("race");
    const inv = await createInvite(ownerA, { kind: "join_workspace", email: e });
    const results = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => accept(inv.token, { name: `R${i}` })));
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    for (const r of results) if (r.status === "rejected") assert.ok(r.reason instanceof InviteFailure);
    const db = await getDb();
    assert.equal((await db.select().from(schema.users).where(eq(schema.users.email, e))).length, 1);
  });

  test("simultaneous accepts of a new-workspace link create exactly one workspace", async () => {
    const e = email("race2");
    const inv = await createInvite(admin, { kind: "new_workspace", email: e, workspaceName: `Race ${run}` });
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => accept(inv.token)));
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    const db = await getDb();
    assert.equal((await db.select().from(schema.workspaces).where(eq(schema.workspaces.name, `Race ${run}`))).length, 1);
  });

  test("with one seat left and two invites outstanding, simultaneous accepts add exactly one member", async () => {
    delete process.env.MAX_WORKSPACE_MEMBERS; // the default of 5
    const { workspaceId, owner } = await fullWorkspace(2);
    const a = await createInvite(owner, { kind: "join_workspace", email: email("one") });
    const b = await createInvite(owner, { kind: "join_workspace", email: email("two") });
    await join((await user(email("took"))).id, workspaceId); // 3 + 2 pending = 5; now a 4th member arrives another way
    await join((await user(email("took2"))).id, workspaceId); // 4 members: one seat left, two invites
    const results = await Promise.allSettled([accept(a.token), accept(b.token)]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1, "only one of the two gets the last seat");
    const db = await getDb();
    const ms = await db.select().from(schema.memberships).where(eq(schema.memberships.workspaceId, workspaceId));
    assert.equal(ms.length, 5, "never over the limit");
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    assert.ok(rejected.reason instanceof InviteFailure && rejected.reason.reason === "workspace_full");
  });

  test("simultaneous invites cannot take the last seat twice", async () => {
    delete process.env.MAX_WORKSPACE_MEMBERS; // the default of 5
    const { workspaceId, owner } = await fullWorkspace(4);
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => createInvite(owner, { kind: "join_workspace", email: email("last") })));
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    const info = await seatInfo(workspaceId);
    assert.equal(info.used, 5);
  });
});
