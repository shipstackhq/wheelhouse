/**
 * Labels, ADR nodes and invite teams as rows (WH-115), against a real database: the service gives back the arrays it always did,
 * the keys keep a link inside one team, and a delete removes what hung off it. Runs on an in-memory PGlite (`pnpm test`), or a
 * real Postgres with TEST_DATABASE_URL.
 */
if (process.env.TEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
} else {
  process.env.PGLITE_DIR = "memory://";
  delete process.env.DATABASE_URL;
}

import { before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import { getDb, schema } from "..";
import type { Actor } from "../../common/actor";
import { ServiceError } from "../../common/service-error";
import { createIssue, deleteIssue, getBoard, getIssue, moveIssue, updateIssue } from "../../modules/issues/issues.legacy";
import { listDecisions, upsertDecision } from "../../modules/map/map.legacy";
import { deleteNode, getGraph, upsertNode } from "../../modules/map/map.legacy";
import { createTeam, deleteTeam } from "../../modules/teams/teams.legacy";
import { createInvite, listInvites, peekInviteAsMember, acceptInviteAsMember } from "../../modules/auth/auth.legacy";
import type { Issuer } from "../../modules/auth/auth.rules";
import { testApp } from "../../test/app";
await testApp();

const RUN = Math.random().toString(16).slice(2, 8);
const L = RUN.replace(/[0-9]/g, (c) => "ghijklmnop"[Number(c)]).slice(0, 2).toUpperCase();
const refusedWith = (code: string) => (e: unknown) => (e as { cause?: { code?: string } }).cause?.code === code;
const foreign = refusedWith("23503");
const unique = refusedWith("23505");

let db: Awaited<ReturnType<typeof getDb>>;
let ada: Actor;
let bea: Actor;
let t1: { id: string; workspaceId: string; key: string };
let t2: { id: string; workspaceId: string; key: string };
let tB: { id: string; workspaceId: string; key: string };
let wsA: string;

before(async () => {
  db = await getDb();
  const mk = async (name: string, role: "owner" | "member" = "owner") => {
    const [w] = await db.insert(schema.workspaces).values({ name: `join ${name} ${RUN}` }).returning();
    const [u] = await db.insert(schema.users).values({ email: `${name}-${RUN}@example.com`, name, passwordHash: "x" }).returning();
    await db.insert(schema.memberships).values({ userId: u.id, workspaceId: w.id, role });
    return { actor: { kind: "human", id: u.id, name, workspaceId: w.id } as Actor, ws: w.id };
  };
  const a = await mk("ada");
  const b = await mk("bea");
  ada = a.actor;
  bea = b.actor;
  wsA = a.ws;
  t1 = await createTeam(ada, { name: "One", key: `${L}A` });
  t2 = await createTeam(ada, { name: "Two", key: `${L}C` });
  tB = await createTeam(bea, { name: "Bee", key: `${L}B` });
});

describe("issue labels", () => {
  test("labels go in and come out as the same list of names, alphabetical, whatever their case or spacing", async () => {
    const t = await createIssue(ada, t1.key, { title: "labelled", labels: ["Bug", " bug ", "UI  polish", "", "api"] });
    assert.deepEqual(t.labels, ["api", "Bug", "UI polish"]);
    assert.deepEqual((await getIssue(ada, t.ref)).issue.labels, ["api", "Bug", "UI polish"]);
    const board = await getBoard(ada, t1.key);
    assert.deepEqual(board.issues.find((x) => x.id === t.id)!.labels, ["api", "Bug", "UI polish"]);
  });

  test("a label is one row per team and name (any case); the same name in another team is another label", async () => {
    const a = await createIssue(ada, t1.key, { title: "a", labels: ["shared"] });
    const b = await createIssue(ada, t1.key, { title: "b", labels: ["SHARED"] });
    const c = await createIssue(ada, t2.key, { title: "c", labels: ["shared"] });
    const rows = await db.select().from(schema.labels).where(eq(schema.labels.name, "shared"));
    assert.equal(rows.filter((r) => r.teamId === t1.id).length, 1);
    assert.equal(rows.filter((r) => r.teamId === t2.id).length, 1);
    assert.deepEqual([a.labels, b.labels, c.labels], [["shared"], ["shared"], ["shared"]], "the first spelling is the label's name");
    await assert.rejects(db.insert(schema.labels).values({ teamId: t1.id, workspaceId: t1.workspaceId, name: "Shared" }), unique);
  });

  test("updating replaces the labels, records the change and bumps the version; the same labels change nothing", async () => {
    const t = await createIssue(ada, t1.key, { title: "edit", labels: ["x", "y"] });
    const same = await updateIssue(ada, t.ref, { labels: ["y", "x"] });
    assert.equal(same.version, t.version, "the same labels in another order is no change");
    const u = await updateIssue(ada, t.ref, { labels: ["y", "z"] }, t.version);
    assert.deepEqual(u.labels, ["y", "z"]);
    assert.equal(u.version, t.version + 1);
    const [ev] = await db.select().from(schema.events).where(and(eq(schema.events.entityId, t.id), eq(schema.events.type, "issue.updated")));
    assert.ok(ev.summary.includes("labels"));
    const cleared = await updateIssue(ada, t.ref, { labels: [] });
    assert.deepEqual(cleared.labels, []);
  });

  test("move, claim and a version conflict still carry the labels", async () => {
    const t = await createIssue(ada, t1.key, { title: "carry", labels: ["keep"] });
    assert.deepEqual((await moveIssue(ada, t.ref, "Todo")).labels, ["keep"]);
    await assert.rejects(
      updateIssue(ada, t.ref, { title: "late" }, 1),
      (e: unknown) => e instanceof ServiceError && e.code === "conflict" && JSON.stringify((e.details as { current: { labels: string[] } }).current.labels) === '["keep"]',
    );
  });

  test("a label has at most 40 characters and an issue at most 20 labels", async () => {
    await assert.rejects(createIssue(ada, t1.key, { title: "long", labels: ["x".repeat(41)] }), (e: unknown) => e instanceof ServiceError && e.code === "invalid");
    await assert.rejects(createIssue(ada, t1.key, { title: "many", labels: Array.from({ length: 21 }, (_, i) => `l${i}`) }), (e: unknown) => e instanceof ServiceError && e.code === "invalid");
  });

  test("deleting a label removes it from its issues; deleting an issue leaves the label", async () => {
    const t = await createIssue(ada, t1.key, { title: "lose a label", labels: ["doomed", "stays"] });
    const [doomed] = await db.select().from(schema.labels).where(and(eq(schema.labels.teamId, t1.id), eq(schema.labels.name, "doomed")));
    await db.delete(schema.labels).where(eq(schema.labels.id, doomed.id));
    assert.deepEqual((await getIssue(ada, t.ref)).issue.labels, ["stays"]);
    await deleteIssue(ada, t.ref);
    assert.equal((await db.select().from(schema.issueLabels).where(eq(schema.issueLabels.issueId, t.id))).length, 0);
    assert.equal((await db.select().from(schema.labels).where(and(eq(schema.labels.teamId, t1.id), eq(schema.labels.name, "stays")))).length, 1);
  });

  test("an issue cannot carry another team's label, and a label cannot name another workspace", async () => {
    const t = await createIssue(ada, t1.key, { title: "t" });
    const other = await createIssue(ada, t2.key, { title: "o", labels: ["theirs"] });
    const [theirs] = await db.select().from(schema.labels).where(and(eq(schema.labels.teamId, t2.id), eq(schema.labels.name, "theirs")));
    await assert.rejects(db.insert(schema.issueLabels).values({ issueId: t.id, labelId: theirs.id, teamId: t1.id, workspaceId: wsA }), foreign);
    await assert.rejects(db.insert(schema.issueLabels).values({ issueId: t.id, labelId: theirs.id, teamId: t2.id, workspaceId: wsA }), foreign);
    await assert.rejects(db.insert(schema.labels).values({ teamId: t1.id, workspaceId: tB.workspaceId, name: "planted" }), foreign);
    assert.equal(other.labels.length, 1);
  });
});

describe("decision nodes", () => {
  const node = async (team: { id: string; key: string }, name: string) => (await upsertNode(ada, team.key, { name, layer: "system", kind: "service", summary: name })).id;

  test("an ADR's nodes come back as nodeIds, are replaced on update and are listed by the graph", async () => {
    const a = await node(t1, `da-${RUN}`);
    const b = await node(t1, `db-${RUN}`);
    const d = await upsertDecision(ada, t1.key, { title: "Use rows", nodes: [a, b, a] });
    assert.deepEqual([...d.nodeIds].sort(), [a, b].sort());
    const u = await upsertDecision(ada, t1.key, { number: d.number, nodes: [b] });
    assert.deepEqual(u.nodeIds, [b]);
    assert.deepEqual((await listDecisions(ada, t1.key)).find((x) => x.id === d.id)!.nodeIds, [b]);
    assert.deepEqual((await getGraph(ada, t1.key)).decisions.find((x) => x.id === d.id)!.nodeIds, [b]);
    const same = await upsertDecision(ada, t1.key, { number: d.number, nodes: [b] });
    assert.equal(same.version, u.version, "the same nodes is no change");
    const none = await upsertDecision(ada, t1.key, { number: d.number, nodes: [] });
    assert.deepEqual(none.nodeIds, []);
  });

  test("deleting a node removes its decision links and nothing else of the decision", async () => {
    const n = await node(t1, `gone-${RUN}`);
    const keep = await node(t1, `keep-${RUN}`);
    const d = await upsertDecision(ada, t1.key, { title: "Loses a node", nodes: [n, keep] });
    await deleteNode(ada, t1.key, n);
    const after = (await listDecisions(ada, t1.key)).find((x) => x.id === d.id)!;
    assert.deepEqual(after.nodeIds, [keep]);
    assert.equal(after.title, "Loses a node");
  });

  test("a decision cannot link another team's node, and a link cannot name another workspace", async () => {
    const mine = await node(t1, `m-${RUN}`);
    const theirs = await node(t2, `t-${RUN}`);
    const d = await upsertDecision(ada, t1.key, { title: "Cross", nodes: [mine] });
    await assert.rejects(db.insert(schema.decisionNodes).values({ decisionId: d.id, nodeId: theirs, teamId: t1.id, workspaceId: wsA }), foreign);
    const mine2 = await node(t1, `m2-${RUN}`);
    await assert.rejects(db.insert(schema.decisionNodes).values({ decisionId: d.id, nodeId: mine2, teamId: t1.id, workspaceId: tB.workspaceId }), foreign);
    await assert.rejects(upsertDecision(ada, t1.key, { number: d.number, nodes: [theirs] }), ServiceError);
  });

  test("deleting a decision removes its links", async () => {
    const n = await node(t1, `dd-${RUN}`);
    const d = await upsertDecision(ada, t1.key, { title: "Short lived", nodes: [n] });
    await db.delete(schema.decisions).where(eq(schema.decisions.id, d.id));
    assert.equal((await db.select().from(schema.decisionNodes).where(eq(schema.decisionNodes.decisionId, d.id))).length, 0);
  });
});

describe("invite teams", () => {
  const issuer = (): Issuer => ({ userId: ada.id, email: `ada-${RUN}@example.com`, workspaceId: wsA, role: "owner" });

  test("an invite carries its teams as rows; the list and the preview read them back; accepting puts the person in", async () => {
    const [u] = await db.insert(schema.users).values({ email: `guest-${RUN}@example.com`, name: "guest", passwordHash: "x" }).returning();
    const created = await createInvite(issuer(), { kind: "join_workspace", email: u.email, role: "member", teams: [{ team: t1.key, role: "editor" }, { team: t2.key, role: "viewer" }] });
    const rows = await db.select().from(schema.inviteTeams).where(eq(schema.inviteTeams.inviteId, created.id));
    assert.deepEqual(rows.map((r) => [r.teamId, r.role]).sort(), [[t1.id, "editor"], [t2.id, "viewer"]].sort());
    const listed = (await listInvites(issuer())).find((i) => i.id === created.id)!;
    assert.deepEqual(listed.teams.map((x) => [x.key, x.role]), [[t1.key, "editor"], [t2.key, "viewer"]]);
    const peek = await peekInviteAsMember({ email: u.email }, created.token);
    assert.deepEqual(peek!.teams.map((x) => x.key), [t1.key, t2.key]);
    await acceptInviteAsMember({ id: u.id, email: u.email }, created.token);
    const mine = await db.select().from(schema.teamMembers).where(eq(schema.teamMembers.userId, u.id));
    assert.deepEqual(mine.map((m) => [m.teamId, m.role]).sort(), [[t1.id, "editor"], [t2.id, "viewer"]].sort());
  });

  test("a deleted team drops out of the invite; a team of another workspace cannot be on it", async () => {
    const gone = await createTeam(ada, { name: "Gone", key: `${L}G` });
    const created = await createInvite(issuer(), { kind: "join_workspace", email: `late-${RUN}@example.com`, role: "member", teams: [{ team: gone.key, role: "editor" }, { team: t1.key, role: "editor" }] });
    await deleteTeam(ada, gone.key);
    assert.deepEqual((await listInvites(issuer())).find((i) => i.id === created.id)!.teams.map((x) => x.key), [t1.key]);
    await assert.rejects(db.insert(schema.inviteTeams).values({ inviteId: created.id, teamId: tB.id, workspaceId: tB.workspaceId, role: "editor" }), foreign);
    await assert.rejects(db.insert(schema.inviteTeams).values({ inviteId: created.id, teamId: tB.id, workspaceId: wsA, role: "editor" }), foreign);
  });

  test("a new-workspace invite has no teams, and revoking or deleting an invite removes its team rows", async () => {
    const created = await createInvite(issuer(), { kind: "join_workspace", email: `del-${RUN}@example.com`, role: "member", teams: [{ team: t1.key, role: "viewer" }] });
    await db.delete(schema.invites).where(eq(schema.invites.id, created.id));
    assert.equal((await db.select().from(schema.inviteTeams).where(eq(schema.inviteTeams.inviteId, created.id))).length, 0);
  });
});
