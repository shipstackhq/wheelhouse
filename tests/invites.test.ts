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
delete process.env.MAX_TEAM_MEMBERS;
delete process.env.INVITE_TTL_HOURS;

import crypto from "node:crypto";
import { beforeEach, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@wheelhouse/core/db";
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
} from "@wheelhouse/core/lib/invites";

const PW = "correct horse battery"; // 21 chars
const run = RUN;
let n = 0;
const email = (p: string) => `${p}-${run}-${++n}@example.com`;
const daysAgo = (d: number) => new Date(Date.now() - d * 864e5);

let teamA: string;
let teamB: string;
let ownerA: Issuer;
let ownerB: Issuer;
let memberA: Issuer;
let admin: Issuer;

async function user(e: string, name = "U") {
  const db = await getDb();
  const [u] = await db.insert(schema.users).values({ email: e, name, passwordHash: "x" }).returning();
  return u;
}
async function team(name: string) {
  const db = await getDb();
  const [t] = await db.insert(schema.teams).values({ name }).returning();
  return t.id;
}
async function join(userId: string, teamId: string, role: "owner" | "member" = "member") {
  const db = await getDb();
  await db.insert(schema.memberships).values({ userId, teamId, role });
}
async function issuerFor(teamId: string, role: "owner" | "member", e: string): Promise<Issuer> {
  const u = await user(e);
  await join(u.id, teamId, role);
  return { userId: u.id, email: e, teamId, role };
}
/** A team with the given number of members (the first is an owner). */
async function fullTeam(members: number) {
  const t = await team(`Team ${++n}`);
  const owner = await issuerFor(t, "owner", email("o"));
  for (let i = 1; i < members; i++) await join((await user(email("m"))).id, t);
  return { teamId: t, owner };
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
  teamA = await team("Team A");
  teamB = await team("Team B");
  ownerA = await issuerFor(teamA, "owner", email("ownerA"));
  memberA = await issuerFor(teamA, "member", email("memberA"));
  ownerB = await issuerFor(teamB, "owner", email("ownerB"));
  const adminTeam = await team("Admin team");
  admin = await issuerFor(adminTeam, "owner", ADMIN_EMAIL);
});

// Most tests keep adding people to the same teams, so give them room; the seat-limit tests use the default.
beforeEach(() => {
  process.env.MAX_TEAM_MEMBERS = "100";
});

describe("tokens", () => {
  test("only a hash is stored: the plain token appears nowhere in the database row", async () => {
    const inv = await createInvite(ownerA, { kind: "join_team", email: email("h") });
    const db = await getDb();
    const [row] = await db.select().from(schema.invites).where(eq(schema.invites.id, inv.id));
    assert.equal(row.tokenHash, crypto.createHash("sha256").update(inv.token).digest("hex"));
    assert.ok(!JSON.stringify(row).includes(inv.token));
    assert.match(inv.token, /^[A-Za-z0-9_-]{43}$/, "32 random bytes, base64url");
    await revokeInvite(ownerA, inv.id);
  });

  test("every invite gets a different token", async () => {
    const a = await createInvite(ownerA, { kind: "join_team", email: email("t1") });
    const b = await createInvite(ownerA, { kind: "join_team", email: email("t2") });
    assert.notEqual(a.token, b.token);
    await revokeInvite(ownerA, a.id);
    await revokeInvite(ownerA, b.id);
  });
});

describe("accepting a join invite", () => {
  test("creates the account, with the invited email, role and tags, in the inviter's team only", async () => {
    const e = email("join");
    const inv = await createInvite(ownerA, { kind: "join_team", email: e.toUpperCase(), role: "member", tags: ["Backend ", "design"] });
    const r = await accept(inv.token, { name: "Joiner" });
    assert.equal(r.teamId, teamA);
    const db = await getDb();
    const [u] = await db.select().from(schema.users).where(eq(schema.users.id, r.userId));
    assert.equal(u.email, e.toLowerCase(), "the stored (lower-cased) email is used");
    assert.equal(u.name, "Joiner");
    const ms = await db.select().from(schema.memberships).where(eq(schema.memberships.userId, r.userId));
    assert.equal(ms.length, 1, "joined exactly one team");
    assert.equal(ms[0].teamId, teamA, "not team B");
    assert.equal(ms[0].role, "member");
    assert.deepEqual(ms[0].tags, ["backend", "design"]);
    const [row] = await db.select().from(schema.invites).where(eq(schema.invites.id, inv.id));
    assert.ok(row.usedAt && row.usedBy === r.userId, "the invite records who used it");
  });

  test("the client cannot choose email, team, kind or role: extra fields are ignored", async () => {
    const e = email("forced");
    const inv = await createInvite(ownerA, { kind: "join_team", email: e, role: "member" });
    const hostile = { token: inv.token, name: "X", password: PW, email: "attacker@example.com", teamId: teamB, role: "owner", kind: "new_team" };
    const r = await acceptInvite(hostile as never);
    const db = await getDb();
    const [u] = await db.select().from(schema.users).where(eq(schema.users.id, r.userId));
    const [m] = await db.select().from(schema.memberships).where(eq(schema.memberships.userId, r.userId));
    assert.equal(u.email, e);
    assert.equal(m.teamId, teamA);
    assert.equal(m.role, "member");
  });

  test("a link works once", async () => {
    const inv = await createInvite(ownerA, { kind: "join_team", email: email("once") });
    await accept(inv.token);
    await failure(accept(inv.token), "invalid");
  });

  test("expired, revoked, unknown and malformed links are all refused alike", async () => {
    const old = await createInvite(ownerA, { kind: "join_team", email: email("old") }, daysAgo(30));
    await failure(accept(old.token), "invalid");

    const revoked = await createInvite(ownerA, { kind: "join_team", email: email("rev") });
    await revokeInvite(ownerA, revoked.id);
    await failure(accept(revoked.token), "invalid");

    await failure(accept(crypto.randomBytes(32).toString("base64url")), "invalid");
    await failure(accept("short"), "invalid");
    await failure(accept("x".repeat(500)), "invalid");
  });

  test("a weak password or empty name is refused without using the invite", async () => {
    const inv = await createInvite(ownerA, { kind: "join_team", email: email("weak") });
    await issueError(accept(inv.token, { password: "short" }), "weak_password");
    await issueError(accept(inv.token, { password: "é".repeat(40) }), "weak_password"); // 80 bytes: bcrypt would truncate
    await issueError(accept(inv.token, { name: "   " }), "invalid");
    assert.ok(await peekInvite(inv.token), "still pending");
    await accept(inv.token);
  });

  test("an email that became an account after the invite was issued is refused and the invite stays pending", async () => {
    const e = email("late");
    const inv = await createInvite(ownerA, { kind: "join_team", email: e });
    await user(e);
    await failure(accept(inv.token), "account_exists");
    const db = await getDb();
    const [row] = await db.select().from(schema.invites).where(eq(schema.invites.id, inv.id));
    assert.equal(row.usedAt, null, "rolled back with the failed account");
  });

  test("peek shows the invite to its holder, and nothing for any bad link", async () => {
    const e = email("peek");
    const inv = await createInvite(ownerA, { kind: "join_team", email: e });
    assert.deepEqual(await peekInvite(inv.token), { email: e, kind: "join_team", teamName: "Team A" });
    assert.equal(await peekInvite("nope"), null);
    await accept(inv.token);
    assert.equal(await peekInvite(inv.token), null, "used");
    const old = await createInvite(ownerA, { kind: "join_team", email: email("peek2") }, daysAgo(30));
    assert.equal(await peekInvite(old.token), null, "expired");
  });
});

describe("who may invite", () => {
  test("only an instance admin can start a new team", async () => {
    await issueError(createInvite(ownerA, { kind: "new_team", email: email("nt") }), "forbidden");
    await issueError(createInvite(memberA, { kind: "new_team", email: email("nt") }), "forbidden");
  });

  test("a plain member cannot invite into the team", async () => {
    await issueError(createInvite(memberA, { kind: "join_team", email: email("nm") }), "forbidden");
  });

  test("a join invite is for the issuer's own team: the owner of B cannot touch A's invites", async () => {
    const inv = await createInvite(ownerA, { kind: "join_team", email: email("scoped") });
    assert.ok((await listInvites(ownerA)).some((i) => i.id === inv.id));
    assert.ok(!(await listInvites(ownerB)).some((i) => i.id === inv.id), "B does not see A's invites");
    await issueError(revokeInvite(ownerB, inv.id), "not_found");
    assert.ok(await peekInvite(inv.token), "still pending");
    await revokeInvite(ownerA, inv.id);
  });

  test("the owner role can be granted only by an owner, and only the stored role is applied", async () => {
    const inv = await createInvite(ownerA, { kind: "join_team", email: email("ownr"), role: "owner" });
    const r = await accept(inv.token);
    const db = await getDb();
    const [m] = await db.select().from(schema.memberships).where(eq(schema.memberships.userId, r.userId));
    assert.equal(m.role, "owner");
  });

  test("a team owner cannot find out whether an email already has an account; only an admin can", async () => {
    const e = email("exists");
    await user(e);
    // Same answer as for an address nobody has used: the invite is created, and the link just never works.
    const inv = await createInvite(ownerA, { kind: "join_team", email: e });
    assert.equal(await peekInvite(inv.token), null, "the link shows nothing");
    await failure(accept(inv.token), "account_exists");
    await issueError(createInvite(admin, { kind: "new_team", email: e }), "conflict");
  });

  test("a second pending invite for the same email is refused until the first is revoked", async () => {
    const e = email("dup");
    const a = await createInvite(ownerA, { kind: "join_team", email: e });
    await issueError(createInvite(ownerA, { kind: "join_team", email: e }), "conflict");
    await revokeInvite(ownerA, a.id);
    await createInvite(ownerA, { kind: "join_team", email: e });
  });

  test("bad emails are refused", async () => {
    await issueError(createInvite(ownerA, { kind: "join_team", email: "not-an-email" }), "invalid");
  });
});

describe("new team invites", () => {
  test("the invitee gets a fresh team that they own, named as the admin said", async () => {
    const e = email("newteam");
    const inv = await createInvite(admin, { kind: "new_team", email: e, teamName: "Acme" });
    assert.deepEqual(await peekInvite(inv.token), { email: e, kind: "new_team", teamName: "Acme" });
    const r = await accept(inv.token, { name: "Founder" });
    assert.notEqual(r.teamId, teamA);
    assert.notEqual(r.teamId, admin.teamId);
    const db = await getDb();
    const [t] = await db.select().from(schema.teams).where(eq(schema.teams.id, r.teamId));
    assert.equal(t.name, "Acme");
    const ms = await db.select().from(schema.memberships).where(eq(schema.memberships.teamId, r.teamId));
    assert.equal(ms.length, 1);
    assert.equal(ms[0].role, "owner");
  });

  test("without a team name the team is named after the person", async () => {
    const inv = await createInvite(admin, { kind: "new_team", email: email("noname") });
    const r = await accept(inv.token, { name: "Sam" });
    const db = await getDb();
    const [t] = await db.select().from(schema.teams).where(eq(schema.teams.id, r.teamId));
    assert.equal(t.name, "Sam's team");
  });

  test("team owners do not see or revoke new-team invites; the admin does", async () => {
    const inv = await createInvite(admin, { kind: "new_team", email: email("adm") });
    assert.ok(!(await listInvites(ownerA)).some((i) => i.id === inv.id));
    await issueError(revokeInvite(ownerA, inv.id), "not_found");
    assert.ok((await listInvites(admin)).some((i) => i.id === inv.id));
    await revokeInvite(admin, inv.id);
    await failure(accept(inv.token), "invalid");
  });

  test("they ignore the seat limit, even when the admin's own team is full", async () => {
    process.env.MAX_TEAM_MEMBERS = "1";
    const inv = await createInvite(admin, { kind: "new_team", email: email("nolimit") });
    await accept(inv.token);
  });
});

describe("the seat limit", () => {
  beforeEach(() => {
    delete process.env.MAX_TEAM_MEMBERS;
  });

  test("five seats by default: the fifth person can be invited, the sixth cannot, and pending invites count", async () => {
    const { teamId, owner } = await fullTeam(1);
    const made = [];
    for (let i = 0; i < 4; i++) made.push(await createInvite(owner, { kind: "join_team", email: email("s") }));
    assert.deepEqual(
      { ...(await seatInfo(teamId)) },
      { members: 1, pending: 4, used: 5, max: 5, full: true },
    );
    await issueError(createInvite(owner, { kind: "join_team", email: email("s6") }), "team_full");
    assert.ok(made.length === 4);
  });

  test("revoking an invite, an expiring invite and removing a member each free a seat", async () => {
    const { teamId, owner } = await fullTeam(3);
    const a = await createInvite(owner, { kind: "join_team", email: email("f") });
    const old = await createInvite(owner, { kind: "join_team", email: email("g") }, daysAgo(30));
    assert.equal((await seatInfo(teamId)).used, 4, "the expired invite does not count");
    await createInvite(owner, { kind: "join_team", email: email("h") });
    await issueError(createInvite(owner, { kind: "join_team", email: email("i") }), "team_full");

    await revokeInvite(owner, a.id);
    const b = await createInvite(owner, { kind: "join_team", email: email("j") });
    await issueError(createInvite(owner, { kind: "join_team", email: email("k") }), "team_full");

    const db = await getDb();
    const [victim] = await db.select().from(schema.memberships).where(eq(schema.memberships.teamId, teamId)).limit(3);
    const members = await db.select().from(schema.memberships).where(eq(schema.memberships.teamId, teamId));
    const removable = members.find((m) => m.userId !== owner.userId)!;
    await db.delete(schema.memberships).where(eq(schema.memberships.userId, removable.userId));
    await createInvite(owner, { kind: "join_team", email: email("l") });
    assert.ok(victim && old && b);
  });

  test("MAX_TEAM_MEMBERS is respected", async () => {
    process.env.MAX_TEAM_MEMBERS = "2";
    const { owner } = await fullTeam(1);
    await createInvite(owner, { kind: "join_team", email: email("c1") });
    await issueError(createInvite(owner, { kind: "join_team", email: email("c2") }), "team_full");
    process.env.MAX_TEAM_MEMBERS = "not a number";
    assert.equal((await seatInfo(owner.teamId)).max, 5, "falls back to the default");
  });

  test("a team that is already over the limit cannot add anyone, and is not shrunk", async () => {
    const { teamId, owner } = await fullTeam(7);
    await issueError(createInvite(owner, { kind: "join_team", email: email("over") }), "team_full");
    const db = await getDb();
    const ms = await db.select().from(schema.memberships).where(eq(schema.memberships.teamId, teamId));
    assert.equal(ms.length, 7);
  });

  test("at acceptance a full team refuses, and the invite stays pending for when a seat frees up", async () => {
    const { teamId, owner } = await fullTeam(3);
    const inv = await createInvite(owner, { kind: "join_team", email: email("late") });
    await join((await user(email("sneak1"))).id, teamId);
    await join((await user(email("sneak2"))).id, teamId); // seats taken behind the invite's back: 5 members
    await failure(accept(inv.token), "team_full");
    assert.ok(await peekInvite(inv.token), "the invite was not consumed");
    const db = await getDb();
    const ms = await db.select().from(schema.memberships).where(eq(schema.memberships.teamId, teamId));
    await db.delete(schema.memberships).where(eq(schema.memberships.userId, ms.find((m) => m.userId !== owner.userId)!.userId));
    await accept(inv.token);
  });
});

describe("races", () => {
  test("simultaneous accepts of one link create exactly one account", async () => {
    const e = email("race");
    const inv = await createInvite(ownerA, { kind: "join_team", email: e });
    const results = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => accept(inv.token, { name: `R${i}` })));
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    for (const r of results) if (r.status === "rejected") assert.ok(r.reason instanceof InviteFailure);
    const db = await getDb();
    assert.equal((await db.select().from(schema.users).where(eq(schema.users.email, e))).length, 1);
  });

  test("simultaneous accepts of a new-team link create exactly one team", async () => {
    const e = email("race2");
    const inv = await createInvite(admin, { kind: "new_team", email: e, teamName: `Race ${run}` });
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => accept(inv.token)));
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    const db = await getDb();
    assert.equal((await db.select().from(schema.teams).where(eq(schema.teams.name, `Race ${run}`))).length, 1);
  });

  test("with one seat left and two invites outstanding, simultaneous accepts add exactly one member", async () => {
    delete process.env.MAX_TEAM_MEMBERS; // the default of 5
    const { teamId, owner } = await fullTeam(2);
    const a = await createInvite(owner, { kind: "join_team", email: email("one") });
    const b = await createInvite(owner, { kind: "join_team", email: email("two") });
    await join((await user(email("took"))).id, teamId); // 3 + 2 pending = 5; now a 4th member arrives another way
    await join((await user(email("took2"))).id, teamId); // 4 members: one seat left, two invites
    const results = await Promise.allSettled([accept(a.token), accept(b.token)]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1, "only one of the two gets the last seat");
    const db = await getDb();
    const ms = await db.select().from(schema.memberships).where(eq(schema.memberships.teamId, teamId));
    assert.equal(ms.length, 5, "never over the limit");
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    assert.ok(rejected.reason instanceof InviteFailure && rejected.reason.reason === "team_full");
  });

  test("simultaneous invites cannot take the last seat twice", async () => {
    delete process.env.MAX_TEAM_MEMBERS; // the default of 5
    const { teamId, owner } = await fullTeam(4);
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => createInvite(owner, { kind: "join_team", email: email("last") })));
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    const info = await seatInfo(teamId);
    assert.equal(info.used, 5);
  });
});
