/**
 * A team's lifecycle and hierarchy (WH-128): leave, retire, restore, delete and the parent team, with the last-active-team and
 * leave rules, the retired write block and the audit lines. Runs against a throwaway in-memory PGlite (`pnpm test`).
 */
if (process.env.TEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
} else {
  process.env.PGLITE_DIR = "memory://";
  delete process.env.DATABASE_URL;
}
process.env.MAX_WORKSPACE_MEMBERS = "100";

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import { getDb, schema } from "../../db";
import type { WorkspaceRole } from "../../db/schema";
import type { Actor } from "../../common/actor";
import * as projects from "../issues/projects";
import * as pmem from "./team-members";
import * as life from "./team-lifecycle";
import { ServiceError } from "../../common/service-error";
import { addComment, createIssue, getBoard, moveIssue } from "../issues/issues";
import { createTeam, deleteTeam, listTeams } from "./teams";

const RUN = Math.random().toString(16).slice(2, 8);
const L = RUN.replace(/[0-9]/g, (c) => "ghijklmnop"[Number(c)]).slice(0, 2).toUpperCase();
let n = 0;
let k = 0;

async function workspace(name: string) {
  const db = await getDb();
  const [t] = await db.insert(schema.workspaces).values({ name }).returning();
  return t;
}
async function person(workspaceId: string, workspaceRole: WorkspaceRole, name: string): Promise<Actor> {
  const db = await getDb();
  const [u] = await db.insert(schema.users).values({ email: `${name}-${RUN}-${++n}@example.com`, name, passwordHash: "x" }).returning();
  await db.insert(schema.memberships).values({ userId: u.id, workspaceId, role: workspaceRole });
  return { kind: "human", id: u.id, name, workspaceId };
}
/** A fresh workspace with an owner, who is admin of the teams they make. */
async function world() {
  const ws = await workspace(`W${++k}-${RUN}`);
  return { ws, owner: await person(ws.id, "owner", "owner") };
}
let t = 0;
const mk = (by: Actor, parent?: string) => {
  const key = `${L}${"ABCDEFGHIJKLMNOPQRSTUVWXYZ"[t++ % 26]}${"ABCDEFGHIJKLMNOPQRSTUVWXYZ"[Math.floor(t / 26) % 26]}`;
  return createTeam(by, { name: `Team ${key}`, key, parent });
};
const code = (c: ServiceError["code"]) => (e: unknown) => e instanceof ServiceError && e.code === c;
const audits = async (teamId: string) => (await (await getDb()).select().from(schema.auditEvents).where(eq(schema.auditEvents.teamId, teamId))).map((a) => a.action);

describe("leave", () => {
  test("the only active team is refused, two teams allow one leave, a retired team does not count", async () => {
    const { ws, owner } = await world();
    const a = await mk(owner);
    const b = await mk(owner);
    const sam = await person(ws.id, "member", "sam");
    await pmem.addTeamMember(owner, a.key, { userId: sam.id, role: "editor" });
    await assert.rejects(() => pmem.removeTeamMember(sam, a.key, sam.id), (e) => code("conflict")(e) && /only active team/.test((e as Error).message));
    assert.match((await life.getTeamSettings(sam, a.key)).canLeave.reason!, /only active team/);
    await pmem.addTeamMember(owner, b.key, { userId: sam.id, role: "editor" });
    assert.equal((await life.getTeamSettings(sam, a.key)).canLeave.allowed, true);
    await pmem.removeTeamMember(sam, a.key, sam.id);
    await assert.rejects(() => pmem.removeTeamMember(sam, b.key, sam.id), (e) => code("conflict")(e) && /only active team/.test((e as Error).message));
    assert.equal((await life.getTeamSettings(sam, b.key)).canLeave.allowed, false);
    // a retired team does not count as one of Sam's teams, and leaving it is always allowed
    await pmem.addTeamMember(owner, a.key, { userId: sam.id, role: "editor" });
    await life.retireTeam(owner, a.key);
    await assert.rejects(() => pmem.removeTeamMember(sam, b.key, sam.id), code("conflict"));
    await pmem.removeTeamMember(sam, a.key, sam.id);
    assert.ok((await audits(a.id)).includes("team.member_left"));
  });

  test("the last admin cannot leave, and an owner is not exempt", async () => {
    const { ws, owner } = await world();
    const a = await mk(owner);
    const b = await mk(owner);
    await assert.rejects(() => pmem.removeTeamMember(owner, a.key, owner.id), (e) => code("conflict")(e) && /another admin/.test((e as Error).message));
    const sam = await person(ws.id, "member", "sam");
    await pmem.addTeamMember(owner, a.key, { userId: sam.id, role: "admin" });
    await pmem.removeTeamMember(owner, a.key, owner.id); // owner is on two teams and a is no longer theirs alone to run
    await assert.rejects(() => pmem.removeTeamMember(owner, b.key, owner.id), code("conflict"));
  });
});

describe("retire and restore", () => {
  test("the last active team cannot be retired; only active teams count; restore lifts it; audited", async () => {
    const { owner } = await world();
    const a = await mk(owner);
    await assert.rejects(() => life.retireTeam(owner, a.key), (e) => code("conflict")(e) && /last active team/.test((e as Error).message));
    const b = await mk(owner);
    await life.retireTeam(owner, a.key);
    await assert.rejects(() => life.retireTeam(owner, b.key), code("conflict"));
    await assert.rejects(() => deleteTeam(owner, b.key), code("conflict"));
    const s = await life.getTeamSettings(owner, b.key);
    assert.equal(s.canRetire.allowed, false);
    assert.equal(s.canDelete.allowed, false);
    assert.match(s.canRetire.reason!, /last active team/);
    assert.deepEqual((await pmem.listTeamsWithRole(owner)).filter((x) => x.retired).map((x) => x.key), [a.key]);
    assert.ok(!(await listTeams(owner)).some((x) => x.key === a.key), "listTeams leaves retired teams out by default");
    await life.restoreTeam(owner, a.key);
    await life.retireTeam(owner, b.key);
    assert.deepEqual((await audits(a.id)).filter((x) => /retired|restored/.test(x)), ["team.retired", "team.restored"]);
  });

  test("only an admin retires or restores; a project lead and child teams block a retire", async () => {
    const { ws, owner } = await world();
    const a = await mk(owner);
    const b = await mk(owner);
    const sam = await person(ws.id, "member", "sam");
    await pmem.addTeamMember(owner, a.key, { userId: sam.id, role: "editor" });
    await assert.rejects(() => life.retireTeam(sam, a.key), code("forbidden"));
    assert.equal((await life.getTeamSettings(sam, a.key)).canRetire.allowed, false);
    const proj = await projects.createProject(owner, { name: "Launch", leadTeam: a.key });
    await assert.rejects(() => life.retireTeam(owner, a.key), (e) => code("conflict")(e) && /leads "Launch"/.test((e as Error).message));
    await projects.deleteProject(owner, proj.id);
    const kid = await mk(owner, a.key);
    await assert.rejects(() => life.retireTeam(owner, a.key), (e) => code("conflict")(e) && /child teams/.test((e as Error).message) && new RegExp(kid.key).test((e as Error).message));
    await life.retireTeam(owner, kid.key);
    await life.retireTeam(owner, a.key); // a retired child no longer blocks
    await assert.rejects(() => life.restoreTeam(sam, a.key), code("forbidden"));
    await assert.rejects(() => life.restoreTeam(owner, b.key), code("conflict")); // not retired
    await life.restoreTeam(owner, a.key);
  });

  test("a retired team refuses issue create, comment, move and agent writes, and stays readable", async () => {
    const { ws, owner } = await world();
    const a = await mk(owner);
    const b = await mk(owner);
    const issue = await createIssue(owner, a.key, { title: "before" });
    const db = await getDb();
    const [key] = await db.insert(schema.apiKeys).values({ workspaceId: ws.id, name: "key", prefix: "wh_x", keyHash: `h-${RUN}-${++n}` }).returning();
    await db.insert(schema.apiKeyTeams).values({ apiKeyId: key.id, teamId: a.id, workspaceId: ws.id });
    const agent: Actor = { kind: "agent", id: key.id, name: "key", workspaceId: ws.id };
    await createIssue(agent, a.key, { title: "agent before" });
    await life.retireTeam(owner, a.key);
    const ref = `${a.key}-${issue.number}`;
    await assert.rejects(() => createIssue(owner, a.key, { title: "no" }), (e) => code("conflict")(e) && /retired/.test((e as Error).message));
    await assert.rejects(() => addComment(owner, ref, "no"), code("conflict"));
    await assert.rejects(() => moveIssue(owner, ref, "Done"), code("conflict"));
    await assert.rejects(() => createIssue(agent, a.key, { title: "no" }), code("conflict"));
    assert.ok((await getBoard(owner, a.key)).issues.length >= 2, "still readable");
    assert.ok((await getBoard(agent, a.key)).issues.length >= 2, "readable by the key too");
    await life.restoreTeam(owner, a.key);
    await createIssue(owner, a.key, { title: "after" });
    assert.ok(b);
  });
});

describe("delete", () => {
  test("the last active team stays; a retired team can go; guards for projects and children", async () => {
    const { ws, owner } = await world();
    const a = await mk(owner);
    await assert.rejects(() => deleteTeam(owner, a.key), (e) => code("conflict")(e) && /last active team/.test((e as Error).message));
    const b = await mk(owner);
    const kid = await mk(owner, b.key);
    await assert.rejects(() => deleteTeam(owner, b.key), (e) => code("conflict")(e) && /child teams/.test((e as Error).message));
    const led = await projects.createProject(owner, { name: "Led", leadTeam: kid.key });
    await assert.rejects(() => deleteTeam(owner, kid.key), (e) => code("conflict")(e) && /leads "Led"/.test((e as Error).message));
    await projects.deleteProject(owner, led.id);
    await life.retireTeam(owner, kid.key);
    await assert.rejects(() => deleteTeam(owner, b.key), code("conflict")); // a retired child still blocks a delete
    await life.setTeamParent(owner, kid.key, null);
    await life.retireTeam(owner, b.key); // b no longer has children
    assert.ok(ws);
    assert.deepEqual(await deleteTeam(owner, b.key), { ok: true, deleted: b.key }); // retired: not limited by the rule
    assert.ok((await audits(b.id)).includes("team.deleted"));
  });
});

describe("parent team", () => {
  test("same workspace only; a self-parent and a cycle are refused; changes are audited", async () => {
    const { ws, owner } = await world();
    const a = await mk(owner);
    const b = await mk(owner, a.key);
    const c = await mk(owner, b.key);
    await assert.rejects(() => life.setTeamParent(owner, a.key, a.key), code("invalid"));
    await assert.rejects(() => life.setTeamParent(owner, a.key, c.key), code("invalid"));
    assert.deepEqual((await life.parentCandidates(owner, a.key)).map((x) => x.key), []);
    const other = await world();
    const foreign = await mk(other.owner);
    await assert.rejects(() => life.setTeamParent(owner, c.key, foreign.key), code("not_found"));
    await assert.rejects(() => mk(owner, foreign.key), code("not_found"));
    await life.setTeamParent(owner, c.key, a.key);
    assert.deepEqual((await audits(c.id)).filter((x) => x === "team.parent_changed"), ["team.parent_changed"]);
    const db = await getDb();
    await assert.rejects(() => db.update(schema.teams).set({ parentId: foreign.id }).where(eq(schema.teams.id, c.id)), "the composite key holds it");
    assert.ok(ws);
  });

  test("a parent grants no access, and a parent you cannot open cannot be picked", async () => {
    const { ws, owner } = await world();
    const sam = await person(ws.id, "member", "sam");
    const top = await mk(owner);
    const child = await mk(owner, top.key);
    await pmem.addTeamMember(owner, top.key, { userId: sam.id, role: "admin" });
    await assert.rejects(() => getBoard(sam, child.key), code("not_found"));
    const samsOwn = await mk(sam);
    await assert.rejects(() => life.setTeamParent(owner, child.key, samsOwn.key), code("not_found"));
    const settings = await life.getTeamSettings(sam, top.key);
    assert.deepEqual(settings.children, []);
    assert.equal(settings.hiddenChildren, 1);
    await assert.rejects(() => life.retireTeam(sam, top.key), (e) => code("conflict")(e) && /1 you cannot see/.test((e as Error).message));
    const db = await getDb();
    assert.ok(await db.select().from(schema.teams).where(and(eq(schema.teams.id, child.id))));
  });
});

describe("concurrency", () => {
  test("two retires of the last two active teams leave one active", async () => {
    const { owner } = await world();
    const a = await mk(owner);
    const b = await mk(owner);
    const results = await Promise.allSettled([life.retireTeam(owner, a.key), life.retireTeam(owner, b.key)]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal((await listTeams(owner)).length, 1);
  });
});
