/**
 * Projects are the unit of isolation (ADR-23): a person reaches a project only as its member, the workspace role never opens
 * one, and every read, write, list, dashboard figure and live stream respects that. Two workspaces, two projects each, and a
 * principal of every kind attack them. Runs against a throwaway in-memory PGlite (`pnpm test`).
 */
if (process.env.TEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
} else {
  process.env.PGLITE_DIR = "memory://";
  delete process.env.DATABASE_URL;
}
process.env.MAX_TEAM_MEMBERS = "100";

import { before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import { getDb, schema } from "../db";
import type { WorkspaceRole } from "../db/schema";
import type { Actor } from "./access";
import { acceptInvite, createInvite, listInvites, type Issuer } from "./invites";
import { removeMember, updateMember } from "./members";
import * as metrics from "./metrics";
import { effectiveRole, roleAllows } from "./project-access";
import * as pmem from "./project-members";
import * as svc from "./service";
import { projectScope, teamScope } from "./stream-scope";

const RUN = Math.random().toString(16).slice(2, 8);
/** Two letters unique to this run (project keys are letters only). */
const L = RUN.replace(/[0-9]/g, (c) => "ghijklmnop"[Number(c)]).slice(0, 2).toUpperCase();
let n = 0;

async function team(name: string) {
  const db = await getDb();
  const [t] = await db.insert(schema.teams).values({ name }).returning();
  return t;
}
async function person(teamId: string, workspaceRole: WorkspaceRole, name: string): Promise<Actor> {
  const db = await getDb();
  const [u] = await db.insert(schema.users).values({ email: `${name}-${RUN}-${++n}@example.com`, name, passwordHash: "x" }).returning();
  await db.insert(schema.memberships).values({ userId: u.id, teamId, role: workspaceRole });
  return { kind: "human", id: u.id, name, teamId };
}
async function agentKey(teamId: string): Promise<Actor> {
  const db = await getDb();
  const [k] = await db.insert(schema.apiKeys).values({ teamId, name: "key", prefix: "wh_x", keyHash: `h-${RUN}-${++n}` }).returning();
  return { kind: "agent", id: k.id, name: "key", teamId };
}
/** A project made by `by`, who becomes its admin through createProject itself. */
const project = (by: Actor, key: string) => svc.createProject(by, { name: `Project ${key}`, key });
const addTo = (admin: Actor, key: string, who: Actor, role: "admin" | "editor" | "viewer") => pmem.addProjectMember(admin, key, { userId: who.id, role });

const code = (c: svc.ServiceError["code"]) => (e: unknown) => e instanceof svc.ServiceError && e.code === c;

let ada: Actor; // owner of A, admin of P1 only
let bob: Actor; // member of A, editor of P1
let cy: Actor; // member of A, viewer of P1
let dee: Actor; // workspace viewer of A, but made editor of P1 (capped to read)
let eve: Actor; // workspace admin of A, in no project
let gus: Actor; // workspace guest of A, viewer of P1
let sam: Actor; // member of A, in P2 only (made by ada's colleague)
let zed: Actor; // owner of B
let keyA: Actor;
let p1: { id: string; key: string };
let p2: { id: string; key: string };
let q1: { id: string; key: string };

before(async () => {
  const A = await team(`A ${RUN}`);
  const B = await team(`B ${RUN}`);
  ada = await person(A.id, "owner", "ada");
  bob = await person(A.id, "member", "bob");
  cy = await person(A.id, "member", "cy");
  dee = await person(A.id, "viewer", "dee");
  eve = await person(A.id, "admin", "eve");
  gus = await person(A.id, "guest", "gus");
  sam = await person(A.id, "member", "sam");
  zed = await person(B.id, "owner", "zed");
  keyA = await agentKey(A.id);
  p1 = await project(ada, `PA${L}`);
  await addTo(ada, p1.key, bob, "editor");
  await addTo(ada, p1.key, cy, "viewer");
  await addTo(ada, p1.key, dee, "editor");
  await addTo(ada, p1.key, gus, "viewer");
  p2 = await project(sam, `PB${L}`);
  q1 = await project(zed, `QA${L}`);
  await svc.createTicket(ada, p1.key, { title: "secret of P1" });
  await svc.createTicket(sam, p2.key, { title: "secret of P2" });
  await svc.createTicket(zed, q1.key, { title: "secret of workspace B" });
});

describe("the rule", () => {
  test("a role is capped by the workspace role, and a role allows what it should", () => {
    assert.equal(effectiveRole("editor", "viewer"), "viewer");
    assert.equal(effectiveRole("admin", "owner"), "admin");
    assert.equal(effectiveRole("editor", "guest"), "editor");
    assert.equal(effectiveRole(null, "owner"), null); // no project row: not even an owner gets in
    assert.equal(roleAllows("viewer", "read"), true);
    assert.equal(roleAllows("viewer", "edit"), false);
    assert.equal(roleAllows("editor", "admin"), false);
    assert.equal(roleAllows("admin", "edit"), true);
  });
});

describe("reading", () => {
  test("a member opens their project; a project they are not in is not_found, the same as one that does not exist", async () => {
    assert.equal((await svc.getProject(ada, p1.key)).id, p1.id);
    await assert.rejects(() => svc.getProject(ada, p2.key), code("not_found"));
    await assert.rejects(() => svc.getProject(ada, "NOPE"), code("not_found"));
    const a = await svc.getProject(ada, p1.key).catch(() => null);
    assert.ok(a);
    const msgOther = await svc.getProject(ada, p2.key).catch((e) => e.message);
    const msgNone = await svc.getProject(ada, "ZZZZ").catch((e) => e.message);
    assert.equal(msgOther.replace(p2.key, "X"), msgNone.replace("ZZZZ", "X")); // same wording: existence does not leak
  });

  test("a workspace owner is not a member of a project made by someone else", async () => {
    await assert.rejects(() => svc.getBoard(ada, p2.key), code("not_found"));
    await assert.rejects(() => svc.getTicket(ada, `${p2.key}-1`), code("not_found"));
  });

  test("a project of another workspace is not_found for everyone here, even by uuid", async () => {
    await assert.rejects(() => svc.getProject(ada, q1.id), code("not_found"));
    await assert.rejects(() => svc.getProject(zed, p1.id), code("not_found"));
    await assert.rejects(() => svc.getTicket(zed, `${p1.key}-1`), code("not_found"));
  });

  test("lists show only your own projects: a workspace admin in none sees none; an agent key sees its whole workspace", async () => {
    assert.deepEqual((await svc.listProjects(ada)).map((p) => p.key), [p1.key]);
    assert.deepEqual((await svc.listProjects(sam)).map((p) => p.key), [p2.key]);
    assert.deepEqual(await svc.listProjects(eve), []);
    assert.deepEqual((await svc.listProjects(keyA)).map((p) => p.key).sort(), [p1.key, p2.key].sort());
    assert.deepEqual((await svc.listProjects(zed)).map((p) => p.key), [q1.key]);
  });

  test("the dashboard counts only the viewer's projects", async () => {
    const s = await metrics.summary(sam);
    const mine = await metrics.projectProgress(sam);
    assert.deepEqual(mine.map((p) => p.key), [p2.key]);
    assert.ok(s);
    assert.deepEqual((await metrics.projectProgress(eve)).map((p) => p.key), []);
    assert.deepEqual((await metrics.projectProgress(keyA)).map((p) => p.key).sort(), [p1.key, p2.key].sort());
    const feed = await metrics.recentActivity(ada);
    assert.ok(feed.every((e) => !/P2|secret of P2/.test(e.summary)));
  });
});

describe("writing", () => {
  test("an editor writes; a viewer, a guest viewer and a workspace viewer made editor can only read", async () => {
    await svc.createTicket(bob, p1.key, { title: "bob's ticket" });
    for (const [who, label] of [[cy, "project viewer"], [gus, "guest viewer"], [dee, "workspace viewer"]] as const) {
      await assert.rejects(() => svc.createTicket(who, p1.key, { title: "no" }), code("forbidden"), label);
      const board = await svc.getBoard(who, p1.key);
      assert.ok(board.tickets.length >= 1, `${label} can still read`);
    }
    const t = (await svc.getBoard(ada, p1.key)).tickets[0];
    await assert.rejects(() => svc.addComment(cy, `${p1.key}-${t.number}`, "hi"), code("forbidden"));
    await assert.rejects(() => svc.moveTicket(dee, `${p1.key}-${t.number}`, "Done"), code("forbidden"));
  });

  test("an editor cannot change who is in the project or delete it; an admin can", async () => {
    await assert.rejects(() => pmem.addProjectMember(bob, p1.key, { userId: sam.id, role: "viewer" }), code("forbidden"));
    await assert.rejects(() => svc.deleteProject(bob, p1.key), code("forbidden"));
    await assert.rejects(() => pmem.listAddableMembers(bob, p1.key), code("forbidden"));
  });

  test("project settings: only a project admin edits the name and description; the key and other projects are untouched", async () => {
    const ps = await project(ada, `PS${L}`); // its own project: the others are shared with later tests
    await addTo(ada, ps.key, bob, "editor");
    await addTo(ada, ps.key, cy, "viewer");
    await assert.rejects(() => svc.updateProject(bob, ps.key, { name: "Hijacked" }), code("forbidden")); // an editor
    await assert.rejects(() => svc.updateProject(cy, ps.key, { name: "Hijacked" }), code("forbidden")); // a viewer
    await assert.rejects(() => svc.updateProject(eve, ps.key, { name: "Hijacked" }), code("not_found")); // workspace admin, not a member
    await assert.rejects(() => svc.updateProject(zed, ps.key, { name: "Hijacked" }), code("not_found")); // another workspace
    await assert.rejects(() => svc.updateProject(keyA, ps.key, { name: "Hijacked" }), code("forbidden")); // an agent key
    await assert.rejects(() => svc.updateProject(ada, ps.key, { name: "   " }), code("invalid"));
    const renamed = await svc.updateProject(ada, ps.key, { name: "Renamed", description: "  About it  " });
    assert.deepEqual([renamed.name, renamed.description, renamed.key], ["Renamed", "About it", ps.key]);
    assert.equal((await svc.getProject(sam, p2.key)).name, `Project ${p2.key}`); // another project is untouched
  });

  test("workspace viewers and guests cannot start projects; members can, and become the project's admin", async () => {
    await assert.rejects(() => svc.createProject(dee, { name: "No", key: "NOV" }), code("forbidden"));
    await assert.rejects(() => svc.createProject(gus, { name: "No", key: "NOG" }), code("forbidden"));
    const mine = await svc.createProject(bob, { name: "Bob's", key: `BB${L}` });
    const list = await pmem.listProjectMembers(bob, mine.key);
    assert.deepEqual(list.members.map((m) => [m.name, m.role]), [["bob", "admin"]]);
  });
});

describe("agents and the system", () => {
  test("an agent key still reaches every project of its own workspace and nothing of another", async () => {
    assert.ok((await svc.getBoard(keyA, p1.key)).project);
    assert.ok((await svc.getBoard(keyA, p2.key)).project);
    await assert.rejects(() => svc.getProject(keyA, q1.key), code("not_found"));
    await svc.createTicket(keyA, p2.key, { title: "from a key" });
  });

  test("a system actor reaches its workspace's projects but is never mistaken for a member", async () => {
    const sys: Actor = { kind: "human", id: "00000000-0000-4000-8000-000000000001", name: "GitHub", teamId: ada.teamId, system: true };
    assert.ok((await svc.getProject(sys, p2.key)).id);
    await assert.rejects(() => svc.getProject(sys, q1.key), code("not_found"));
    const notSystem: Actor = { ...sys, system: undefined };
    await assert.rejects(() => svc.getProject(notSystem, p2.key), code("not_found"));
  });
});

describe("who is in a project", () => {
  test("members are listed to any member; adding needs a workspace member; duplicates and strangers are refused", async () => {
    const seen = await pmem.listProjectMembers(cy, p1.key);
    assert.equal(seen.myRole, "viewer");
    assert.deepEqual(seen.members.map((m) => m.name).sort(), ["ada", "bob", "cy", "dee", "gus"]);
    const addable = (await pmem.listAddableMembers(ada, p1.key)).map((m) => m.name);
    assert.ok(addable.includes("eve") && addable.includes("sam") && !addable.includes("bob"));
    await assert.rejects(() => addTo(ada, p1.key, bob, "viewer"), code("conflict"));
    await assert.rejects(() => pmem.addProjectMember(ada, p1.key, { userId: zed.id, role: "viewer" }), code("not_found")); // another workspace
    await assert.rejects(() => pmem.addProjectMember(ada, p1.key, { userId: sam.id, role: "owner" }), code("invalid"));
    await addTo(ada, p1.key, sam, "viewer");
    assert.equal((await svc.getProject(sam, p1.key)).id, p1.id);
    await pmem.removeProjectMember(ada, p1.key, sam.id);
    await assert.rejects(() => svc.getProject(sam, p1.key), code("not_found"));
  });

  test("a project keeps at least one admin: the last one cannot be demoted, removed or leave", async () => {
    await assert.rejects(() => pmem.setProjectMemberRole(ada, p1.key, ada.id, "editor"), code("conflict"));
    await assert.rejects(() => pmem.removeProjectMember(ada, p1.key, ada.id), code("conflict"));
    await pmem.setProjectMemberRole(ada, p1.key, bob.id, "admin");
    await pmem.setProjectMemberRole(ada, p1.key, ada.id, "editor"); // fine now: bob is admin too
    await pmem.setProjectMemberRole(bob, p1.key, ada.id, "admin");
    await pmem.setProjectMemberRole(bob, p1.key, bob.id, "editor");
  });

  test("agents cannot manage members", async () => {
    await assert.rejects(() => pmem.addProjectMember(keyA, p1.key, { userId: sam.id, role: "viewer" }), code("forbidden"));
  });
});

describe("workspace owners and admins", () => {
  test("they see every project by name and who administers it, not what is inside", async () => {
    const all = await pmem.listWorkspaceProjects(eve);
    const row = all.find((p) => p.key === p2.key)!;
    assert.deepEqual(row.admins, ["sam"]);
    assert.equal(row.isMember, false);
    await assert.rejects(() => pmem.listWorkspaceProjects(bob), code("forbidden"));
    await assert.rejects(() => svc.getBoard(eve, p2.key), code("not_found")); // seeing the name opens nothing
  });

  test("joining as admin is audited, shows in the project's own activity, and members can see it", async () => {
    await pmem.joinProjectAsWorkspaceAdmin(eve, p2.key);
    assert.equal((await svc.getProject(eve, p2.key)).id, p2.id);
    const audit = await pmem.listAudit(ada, { projectRef: p2.key });
    assert.ok(audit.some((a) => a.action === "project.admin_joined" && a.actorName === "eve"));
    const feed = await svc.listEvents(sam, p2.key);
    assert.ok(JSON.stringify(feed).includes("joined"));
    await assert.rejects(() => pmem.joinProjectAsWorkspaceAdmin(eve, p2.key), code("conflict")); // already in
    await assert.rejects(() => pmem.joinProjectAsWorkspaceAdmin(bob, p2.key), code("forbidden")); // a plain member cannot
    await assert.rejects(() => pmem.listAudit(bob), code("forbidden"));
  });

  test("a workspace admin cannot reach another workspace's project at all", async () => {
    await assert.rejects(() => pmem.joinProjectAsWorkspaceAdmin(eve, q1.key), code("not_found"));
  });
});

describe("removing someone from the workspace", () => {
  test("is refused while they are a project's only admin, then removes every project row", async () => {
    const lee = await person(ada.teamId, "member", "lee");
    const leesProject = await svc.createProject(lee, { name: "Lee's", key: `LL${L}` });
    await assert.rejects(() => removeMember(ada.teamId, ada.id, lee.id), code("conflict"));
    await pmem.joinProjectAsWorkspaceAdmin(eve, leesProject.key);
    assert.equal(await removeMember(ada.teamId, ada.id, lee.id), true);
    const db = await getDb();
    const left = await db.select().from(schema.projectMembers).where(and(eq(schema.projectMembers.userId, lee.id)));
    assert.equal(left.length, 0);
    await assert.rejects(() => svc.getProject(lee, leesProject.key), code("not_found")); // no workspace membership either
  });
});

describe("invites that carry projects", () => {
  const issuerOf = (a: Actor, role: WorkspaceRole): Issuer => ({ userId: a.id, email: `${a.name}@example.com`, teamId: a.teamId, role });
  const PW = "correct horse battery";

  test("the new person lands in exactly the chosen projects with the chosen role, and it is audited in the inviter's name", async () => {
    const inv = await createInvite(issuerOf(ada, "owner"), { kind: "join_team", email: `new-${RUN}-1@example.com`, role: "member", projects: [{ project: p1.key, role: "viewer" }] });
    const pending = (await listInvites(issuerOf(ada, "owner"))).find((i) => i.id === inv.id)!;
    assert.deepEqual(pending.projects, [{ key: p1.key, name: `Project ${p1.key}`, role: "viewer" }]);
    const { userId } = await acceptInvite({ token: inv.token, name: "Newbie", password: PW });
    const newbie: Actor = { kind: "human", id: userId, name: "Newbie", teamId: ada.teamId };
    assert.deepEqual((await svc.listProjects(newbie)).map((p) => p.key), [p1.key]);
    await assert.rejects(() => svc.getProject(newbie, p2.key), code("not_found"));
    await assert.rejects(() => svc.createTicket(newbie, p1.key, { title: "no" }), code("forbidden")); // the viewer role they were given
    const log = await pmem.listAudit(ada, { projectRef: p1.key });
    const line = log.find((a) => a.action === "project.member_added" && a.targetId === userId)!;
    assert.deepEqual([line.actorName, line.after], ["ada", { role: "viewer", via: "invite" }]);
  });

  test("an invite with no projects leaves the person in none, as before", async () => {
    const inv = await createInvite(issuerOf(ada, "owner"), { kind: "join_team", email: `new-${RUN}-2@example.com` });
    const { userId } = await acceptInvite({ token: inv.token, name: "Plain", password: PW });
    assert.deepEqual(await svc.listProjects({ kind: "human", id: userId, name: "Plain", teamId: ada.teamId }), []);
  });

  test("you can only hand out projects you administer, never another workspace's, and at most 20", async () => {
    const asEve = issuerOf(eve, "admin"); // a workspace admin, but in no project
    await assert.rejects(() => createInvite(asEve, { kind: "join_team", email: `new-${RUN}-3@example.com`, projects: [{ project: p1.key, role: "viewer" }] }), (e) => (e as { code?: string }).code === "forbidden");
    await assert.rejects(() => createInvite(issuerOf(bob, "member"), { kind: "join_team", email: `new-${RUN}-4@example.com`, projects: [{ project: p1.key, role: "viewer" }] }), (e) => (e as { code?: string }).code === "forbidden"); // not a manager at all
    await assert.rejects(() => createInvite(issuerOf(ada, "owner"), { kind: "join_team", email: `new-${RUN}-5@example.com`, projects: [{ project: q1.key, role: "viewer" }] }), (e) => (e as { code?: string }).code === "forbidden"); // another workspace
    await assert.rejects(() => createInvite(issuerOf(ada, "owner"), { kind: "join_team", email: `new-${RUN}-6@example.com`, projects: [{ project: p1.key, role: "owner" as never }] }), (e) => (e as { code?: string }).code === "invalid");
  });

  test("a project deleted before the invite is accepted is skipped, not an error", async () => {
    const mine = await svc.createProject(ada, { name: "Short lived", key: `SL${L}` });
    const inv = await createInvite(issuerOf(ada, "owner"), { kind: "join_team", email: `new-${RUN}-7@example.com`, projects: [{ project: mine.key, role: "editor" }, { project: p1.key, role: "viewer" }] });
    await svc.deleteProject(ada, mine.key);
    const { userId } = await acceptInvite({ token: inv.token, name: "Late", password: PW });
    assert.deepEqual((await svc.listProjects({ kind: "human", id: userId, name: "Late", teamId: ada.teamId })).map((p) => p.key), [p1.key]);
  });
});

describe("the audit log", () => {
  test("a workspace role change and a removal are written down, with who did it and what changed", async () => {
    const t = await person(ada.teamId, "member", "audited");
    assert.equal(await updateMember(ada.teamId, ada.id, { userId: t.id, role: "viewer", tags: [] }), true);
    assert.equal(await removeMember(ada.teamId, ada.id, t.id), true);
    const log = await pmem.listAudit(ada, { limit: 50 });
    const changed = log.find((a) => a.action === "workspace.role_changed" && a.targetId === t.id)!;
    assert.deepEqual([changed.actorName, changed.before, changed.after], ["ada", { role: "member" }, { role: "viewer" }]);
    assert.ok(log.some((a) => a.action === "workspace.member_removed" && a.targetId === t.id));
    assert.ok(log.every((a) => a.seq > 0));
    // an unchanged role writes nothing
    const u = await person(ada.teamId, "member", "steady");
    const before = (await pmem.listAudit(ada, { limit: 500 })).length;
    await updateMember(ada.teamId, ada.id, { userId: u.id, role: "member", tags: ["x"] });
    assert.equal((await pmem.listAudit(ada, { limit: 500 })).length, before);
  });
});

describe("live streams", () => {
  test("the dashboard stream replays and delivers only events of projects the person is in", async () => {
    const adaScope = await teamScope()(ada);
    const samScope = await teamScope()(sam);
    const keyScope = await teamScope()(keyA);
    const ev = (projectId: string) => ({ teamId: ada.teamId, projectId, type: "ticket.created" });
    assert.equal(adaScope.allow?.(ev(p1.id)), true);
    assert.equal(adaScope.allow?.(ev(p2.id)), false);
    assert.equal(samScope.allow?.(ev(p2.id)), true);
    assert.equal(samScope.allow?.(ev(p1.id)), false);
    assert.equal(keyScope.allow, undefined); // a whole-workspace scope: no filter
    const nobody = await teamScope()(await person(ada.teamId, "member", "nobody"));
    assert.equal(nobody.allow?.(ev(p1.id)), false);
  });

  test("an open dashboard stream follows joins and removals, and a project stream ends when its person is removed", async () => {
    const stream = await person(ada.teamId, "member", "watcher");
    const scope = await teamScope()(stream);
    const ev = (projectId: string) => ({ teamId: ada.teamId, projectId, type: "ticket.created" });
    assert.equal(scope.allow?.(ev(p1.id)), false);
    await addTo(ada, p1.key, stream, "viewer");
    assert.equal(await scope.recheck?.(), true);
    assert.equal(scope.allow?.(ev(p1.id)), true); // joined while the page was open
    const one = await projectScope(p1.key)(stream);
    assert.equal(await one.recheck?.(), true);
    await pmem.removeProjectMember(ada, p1.key, stream.id);
    assert.equal(await one.recheck?.(), false); // the project stream ends
    await scope.recheck?.();
    assert.equal(scope.allow?.(ev(p1.id)), false); // and the dashboard stops hearing it
  });
});

describe("the per-project dashboard (WH-107)", () => {
  let owner: Actor;
  let one: { id: string; key: string };
  let two: { id: string; key: string };
  let viewer: Actor;
  const days = (n: number) => new Date(Date.now() - n * 864e5);

  before(async () => {
    const T = await team(`Dash ${RUN}`);
    owner = await person(T.id, "owner", "dashowner");
    viewer = await person(T.id, "member", "dashviewer");
    one = await project(owner, `DA${L}`);
    two = await project(owner, `DB${L}`);
    await addTo(owner, one.key, viewer, "viewer");
    // project one: 3 tickets (one done, one in progress for 9 days, one in review for 4 days); project two: 1 urgent ticket
    const t1 = await svc.createTicket(owner, one.key, { title: "done one" });
    const t2 = await svc.createTicket(owner, one.key, { title: "slow one", priority: "high" });
    const t3 = await svc.createTicket(owner, one.key, { title: "waiting one" });
    await svc.moveTicket(owner, `${one.key}-${t1.number}`, "done");
    await svc.moveTicket(owner, `${one.key}-${t2.number}`, "in_progress");
    await svc.moveTicket(owner, `${one.key}-${t3.number}`, "review");
    await svc.createTicket(owner, two.key, { title: "urgent elsewhere", priority: "urgent" });
    // age the moves: the events say when each ticket arrived in its column
    const db = await getDb();
    const moved = await db.select().from(schema.events).where(and(eq(schema.events.projectId, one.id), eq(schema.events.type, "ticket.moved")));
    for (const e of moved) {
      const age = e.summary.includes(`${one.key}-${t2.number}`) ? 9 : e.summary.includes(`${one.key}-${t3.number}`) ? 4 : 1;
      await db.update(schema.events).set({ createdAt: days(age) }).where(eq(schema.events.seq, e.seq));
    }
  });

  test("a project's numbers are its own: the workspace totals include both, the project's only itself", async () => {
    const all = await metrics.summary(owner);
    const mine = await metrics.summary(owner, one.id);
    assert.equal(all.projects, 2);
    assert.equal(mine.projects, 1);
    assert.equal(mine.open, 2); // slow + waiting; the done one is not open
    assert.equal(mine.inProgress, 1);
    assert.equal(mine.inReview, 1);
    assert.equal(all.open, mine.open + 1); // plus the other project's ticket
    const progress = await metrics.projectProgress(owner, one.id);
    assert.deepEqual(progress.map((p) => [p.key, p.total, p.done]), [[one.key, 3, 1]]);
    assert.equal(progress[0].urgent, 1); // the high-priority one only; the urgent ticket belongs to the other project
  });

  test("attention, activity and throughput read only that project", async () => {
    const att = await metrics.needsAttention(owner, one.id);
    assert.deepEqual(att.review.map((r) => r.title), ["waiting one"]);
    assert.deepEqual(att.urgent, []); // the urgent ticket is in the other project
    assert.deepEqual((await metrics.needsAttention(owner, two.id)).urgent.map((u) => u.title), ["urgent elsewhere"]);
    const feed = await metrics.recentActivity(owner, 50, one.id);
    assert.ok(feed.length > 0 && feed.every((e) => e.projectKey === one.key));
    const through = await metrics.throughput(owner, 14, one.id);
    assert.equal(through.reduce((n, d) => n + d.created, 0), 3);
    assert.equal((await metrics.throughput(owner, 14)).reduce((n, d) => n + d.created, 0), 4);
  });

  test("focus ranks what has sat longest, and says who is in the project", async () => {
    const f = await metrics.projectFocus(owner, one.id);
    assert.deepEqual(f.aging.map((a) => [a.title, a.days]), [["slow one", 9]]);
    assert.deepEqual(f.waitingReview.map((a) => [a.title, a.days]), [["waiting one", 4]]);
    assert.deepEqual([f.tickets, f.members.count, f.members.myRole, f.proposedDecisions], [3, 2, "admin", 0]);
    assert.equal((await metrics.projectFocus(viewer, one.id)).members.myRole, "viewer");
  });

  test("another project's id is never read: a person who is not in it gets an empty snapshot, not its numbers", async () => {
    assert.equal((await metrics.summary(viewer, two.id)).projects, 0);
    assert.equal((await metrics.summary(viewer, two.id)).open, 0);
    const f = await metrics.projectFocus(viewer, two.id);
    assert.deepEqual([f.aging, f.waitingReview, f.tickets, f.members.count], [[], [], 0, 0]);
    // and a viewer sees the workspace dashboard limited to the one project they are in
    assert.equal((await metrics.summary(viewer)).projects, 1);
  });

  test("an empty project has numbers of zero and nothing to focus on", async () => {
    const e = await project(owner, `DE${L}`);
    const s = await metrics.summary(owner, e.id);
    assert.deepEqual([s.projects, s.open, s.completed7d, s.agentsActive7d], [1, 0, 0, 0]);
    const f = await metrics.projectFocus(owner, e.id);
    assert.deepEqual([f.aging, f.waitingReview, f.quiet, f.tickets], [[], [], [], 0]);
    assert.equal((await metrics.projectProgress(owner, e.id))[0].pct, 0);
  });
});
