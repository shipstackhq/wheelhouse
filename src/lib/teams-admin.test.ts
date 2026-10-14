/**
 * Admin teams page and team suspension (WH-52). Runs against a throwaway in-memory PGlite (`pnpm test`).
 * To run against a real Postgres instead:
 *   TEST_DATABASE_URL=postgres://... npx tsx --conditions=react-server --test --test-force-exit src/lib/teams-admin.test.ts
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
process.env.MAX_TEAM_MEMBERS = "100";

import crypto from "node:crypto";
import { before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { actorForKey, SuspendedError, TEAM_SUSPENDED_MESSAGE, sha256, userForSessionToken, userTeamSuspended } from "./access";
import { acceptInvite, createInvite, InviteError, InviteFailure, peekInvite, type Issuer } from "./invites";
import { AdminError, getTeamDetail, listTeams, restoreTeam, suspendTeam, type Admin } from "./teams-admin";
import * as svc from "./service";

const PW = "correct horse battery";
let n = 0;
const email = (p: string) => `${p}-${RUN}-${++n}@example.com`;

type Side = { teamId: string; name: string; owner: Issuer; member: { userId: string }; key: string; token: string; memberToken: string };
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
  const [t] = await db.insert(schema.teams).values({ name }).returning();
  const o = await user(email("owner"), `${name} owner`);
  const m = await user(email("member"), `${name} member`);
  await db.insert(schema.memberships).values({ userId: o.id, teamId: t.id, role: "owner" });
  await db.insert(schema.memberships).values({ userId: m.id, teamId: t.id, role: "member" });
  const key = `wh_${crypto.randomBytes(18).toString("base64url")}`;
  await db.insert(schema.apiKeys).values({ teamId: t.id, name: `${name} key`, prefix: key.slice(0, 10), keyHash: sha256(key), createdBy: o.id });
  return {
    teamId: t.id,
    name,
    owner: { userId: o.id, email: o.email, teamId: t.id, role: "owner" },
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
  await db.insert(schema.memberships).values({ userId: a.id, teamId: home.teamId, role: "owner" });
  admin = { userId: a.id, email: ADMIN_EMAIL, teamId: home.teamId };
  adminIssuer = { userId: a.id, email: ADMIN_EMAIL, teamId: home.teamId, role: "owner" };
  X = await side(`Acme ${RUN}`);
  Y = await side(`Beta ${RUN}`);
});

describe("who may use the admin functions", () => {
  test("a team owner who is not an instance admin is refused by every function", async () => {
    const notAdmin: Admin = { userId: X.owner.userId, email: X.owner.email, teamId: X.teamId };
    await adminError(listTeams(notAdmin), "forbidden");
    await adminError(getTeamDetail(notAdmin, Y.teamId), "forbidden");
    await adminError(suspendTeam(notAdmin, Y.teamId, { confirmName: Y.name }), "forbidden");
    await adminError(restoreTeam(notAdmin, Y.teamId), "forbidden");
    assert.equal(await userTeamSuspended(Y.owner.userId), false, "nothing changed");
  });
});

describe("the teams list", () => {
  test("shows every team with correct counts, owners and the caller's own team", async () => {
    await createInvite(X.owner, { kind: "join_team", email: email("pend") }); // one pending invite for Acme
    const db = await getDb();
    await db.insert(schema.projects).values({ teamId: X.teamId, key: "AC", name: "Acme app" });
    const rows = await listTeams(admin);
    const x = rows.find((t) => t.id === X.teamId)!;
    assert.deepEqual(
      { members: x.members, pending: x.pendingInvites, used: x.seatsUsed, projects: x.projects, suspended: !!x.suspendedAt, yours: x.isYours },
      { members: 2, pending: 1, used: 3, projects: 1, suspended: false, yours: false },
    );
    assert.deepEqual(x.owners.map((o) => o.email), [X.owner.email]);
    assert.ok(rows.find((t) => t.id === admin.teamId)!.isYours);
    assert.ok(rows.some((t) => t.id === Y.teamId));
  });

  test("records who invited a team that was started from an invite", async () => {
    const inv = await createInvite(adminIssuer, { kind: "new_team", email: email("founder"), teamName: `Founded ${RUN}` });
    const r = await acceptInvite({ token: inv.token, name: "Founder", password: PW });
    const t = (await listTeams(admin)).find((x) => x.id === r.teamId)!;
    assert.deepEqual(t.invitedBy, { name: "Admin", email: ADMIN_EMAIL });
    assert.equal(t.name, `Founded ${RUN}`);
  });

  test("shows no team content: a ticket's title and a comment never appear on the admin pages", async () => {
    const human = { kind: "human" as const, id: X.owner.userId, name: "o", teamId: X.teamId };
    await svc.createProject(human, { name: "Secret project", key: "SEC" });
    const ticket = await svc.createTicket(human, "SEC", { title: `TOP-SECRET-TITLE-${RUN}`, body: `TOP-SECRET-BODY-${RUN}` });
    await svc.addComment(human, ticket.ref, `TOP-SECRET-COMMENT-${RUN}`);
    const everything = JSON.stringify([await listTeams(admin), await getTeamDetail(admin, X.teamId)]);
    assert.ok(!everything.includes("TOP-SECRET"), "metadata only");
    assert.ok(!everything.includes("Secret project"), "not even project names");
  });

  test("the detail lists members, invites with their status, and API keys without the key itself", async () => {
    const d = await getTeamDetail(admin, X.teamId);
    assert.deepEqual(d.memberList.map((m) => m.role).sort(), ["member", "owner"]);
    assert.ok(d.inviteList.some((i) => i.status === "pending"));
    assert.equal(d.keys.length, 1);
    assert.ok(d.keys[0].prefix.startsWith("wh_"));
    assert.ok(!JSON.stringify(d).includes(X.key), "the full key is never shown");
    assert.ok(!JSON.stringify(d).includes(sha256(X.key)), "nor its hash");
    await adminError(getTeamDetail(admin, crypto.randomUUID()), "not_found");
  });
});

describe("suspending a team", () => {
  let pendingToken: string;
  before(async () => {
    pendingToken = (await createInvite(X.owner, { kind: "join_team", email: email("inert") })).token;
  });

  test("refuses the admin's own team, an unknown team and a wrong confirmation", async () => {
    await adminError(suspendTeam(admin, admin.teamId, { confirmName: "anything" }), "conflict");
    await adminError(suspendTeam(admin, crypto.randomUUID(), { confirmName: "x" }), "not_found");
    await adminError(suspendTeam(admin, X.teamId, { confirmName: "acme" }), "invalid");
    await adminError(suspendTeam(admin, X.teamId, { confirmName: "" }), "invalid");
    assert.equal(await userTeamSuspended(X.owner.userId), false, "still active");
  });

  test("signs the team out, refuses its logins and its API keys, blocks its invites, and leaves other teams alone", async () => {
    assert.ok(await userForSessionToken(X.token), "signed in before");
    assert.ok(await actorForKey(X.key, "1.1.1.1"), "key works before");

    const r = await suspendTeam(admin, X.teamId, { confirmName: ` ${X.name} `, reason: "  abuse report  " });
    assert.equal(r.sessionsEnded, 2, "both members' sessions were deleted");

    const db = await getDb();
    const [t] = await db.select().from(schema.teams).where(eq(schema.teams.id, X.teamId));
    assert.ok(t.suspendedAt);
    assert.equal(t.suspendedBy, admin.userId);
    assert.equal(t.suspendedReason, "abuse report");

    assert.equal(await userForSessionToken(X.token), null, "the old session is gone");
    assert.equal(await userForSessionToken(X.memberToken), null);
    const fresh = await session(X.owner.userId); // even a session that somehow exists is treated as signed out
    assert.equal(await userForSessionToken(fresh), null);
    assert.equal(await userTeamSuspended(X.owner.userId), true, "so the login action can refuse");
    assert.equal(await userTeamSuspended(X.member.userId), true);

    await assert.rejects(actorForKey(X.key, "1.1.1.1"), (e: unknown) => e instanceof SuspendedError && e.status === 403 && e.message === TEAM_SUSPENDED_MESSAGE);

    await assert.rejects(createInvite(X.owner, { kind: "join_team", email: email("blocked") }), (e: unknown) => e instanceof InviteError && e.code === "forbidden");
    assert.equal(await peekInvite(pendingToken), null, "its pending invite looks invalid");
    await assert.rejects(acceptInvite({ token: pendingToken, name: "Nope", password: PW }), (e: unknown) => e instanceof InviteFailure && e.reason === "invalid");

    // team Y is untouched
    assert.ok(await userForSessionToken(Y.token));
    assert.ok(await userForSessionToken(Y.memberToken));
    assert.ok(await actorForKey(Y.key, "1.1.1.1"));
    assert.equal(await userTeamSuspended(Y.owner.userId), false);
    const list = await listTeams(admin);
    assert.ok(list.find((x) => x.id === X.teamId)!.suspendedAt);
    assert.equal(list.find((x) => x.id === Y.teamId)!.suspendedAt, null);
  });

  test("suspending twice is refused, and the data is still there", async () => {
    await adminError(suspendTeam(admin, X.teamId, { confirmName: X.name }), "conflict");
    const d = await getTeamDetail(admin, X.teamId);
    assert.equal(d.memberList.length, 2);
    assert.equal(d.keys.length, 1);
    assert.equal(d.suspendedBy?.email, ADMIN_EMAIL);
    assert.equal(d.suspendedReason, "abuse report");
  });

  test("restoring brings the team back as it was: keys, invites and members, but people sign in again", async () => {
    await restoreTeam(admin, X.teamId);
    assert.equal(await userTeamSuspended(X.owner.userId), false);
    assert.ok(await actorForKey(X.key, "1.1.1.1"), "the same key works again");
    assert.equal(await userForSessionToken(X.token), null, "sessions were ended and are not recreated");
    assert.ok(await userForSessionToken(await session(X.owner.userId)), "a new sign-in works");
    assert.ok(await peekInvite(pendingToken), "the unexpired invite works again");
    const r = await acceptInvite({ token: pendingToken, name: "Joiner", password: PW });
    assert.equal(r.teamId, X.teamId);
    const d = await getTeamDetail(admin, X.teamId);
    assert.equal(d.suspendedAt, null);
    assert.equal(d.suspendedReason, null);
    await adminError(restoreTeam(admin, X.teamId), "conflict");
  });

  test("a second admin account in another team can suspend a team that is not theirs", async () => {
    const db = await getDb();
    const otherTeam = await side(`Other ${RUN}`);
    const o = await user(email("admin2"), "Admin Two");
    await db.insert(schema.memberships).values({ userId: o.id, teamId: otherTeam.teamId, role: "owner" });
    process.env.ADMIN_EMAILS = `${ADMIN_EMAIL},${o.email}`;
    try {
      const a2: Admin = { userId: o.id, email: o.email, teamId: otherTeam.teamId };
      await suspendTeam(a2, Y.teamId, { confirmName: Y.name });
      await adminError(suspendTeam(a2, otherTeam.teamId, { confirmName: otherTeam.name }), "conflict");
      await restoreTeam(a2, Y.teamId);
    } finally {
      process.env.ADMIN_EMAILS = ADMIN_EMAIL;
    }
  });
});
