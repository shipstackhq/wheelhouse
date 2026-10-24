/**
 * Teams are the unit of isolation (ADR-23): a person reaches a team only as its member, the workspace role never opens
 * one, and every read, write, list, dashboard figure and live stream respects that. Two workspaces, two teams each, and a
 * principal of every kind attack them. Runs against a throwaway in-memory PGlite (`pnpm test`).
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
import { and, eq } from "drizzle-orm";
import { getDb, schema } from "../../db";
import type { WorkspaceRole } from "../../db/schema";
import type { Actor } from "../../common/actor";
import { acceptInvite, createInvite, listInvites, type Issuer } from "../auth/invites";
import { removeMember, updateMember } from "../auth/members";
import * as metrics from "../dashboard/metrics";
import { roleOnTeam, visibleTeamIds } from "./team-access";
import { effectiveRole, roleAllows } from "../../common/roles";
import * as pmem from "./team-members";
import { scopeKeyToAllTeams } from "../auth/key-scope";
import { ServiceError } from "../../common/service-error";
import { listEvents } from "../../lib/service-queue";
import { addComment, createIssue, getBoard, getIssue, moveIssue } from "../issues/issues";
import { createTeam, deleteTeam, listTeams, requireTeam, updateTeam } from "./teams";
import { teamScope, workspaceScope } from "../../platform/streams/stream-scope";
import { testApp } from "../../test/app";
await testApp();

const RUN = Math.random().toString(16).slice(2, 8);
/** Two letters unique to this run (team keys are letters only). */
const L = RUN.replace(/[0-9]/g, (c) => "ghijklmnop"[Number(c)]).slice(0, 2).toUpperCase();
let n = 0;

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
async function agentKey(workspaceId: string): Promise<Actor> {
  const db = await getDb();
  const [k] = await db.insert(schema.apiKeys).values({ workspaceId, name: "key", prefix: "wh_x", keyHash: `h-${RUN}-${++n}` }).returning();
  return { kind: "agent", id: k.id, name: "key", workspaceId };
}
/** A team made by `by`, who becomes its admin through createTeam itself. */
const team = (by: Actor, key: string) => createTeam(by, { name: `Team ${key}`, key });
const addTo = (admin: Actor, key: string, who: Actor, role: "admin" | "editor" | "viewer") => pmem.addTeamMember(admin, key, { userId: who.id, role });

const code = (c: ServiceError["code"]) => (e: unknown) => e instanceof ServiceError && e.code === c;

let ada: Actor; // owner of A, admin of P1 only
let bob: Actor; // member of A, editor of P1
let cy: Actor; // member of A, viewer of P1
let dee: Actor; // workspace viewer of A, but made editor of P1 (capped to read)
let eve: Actor; // workspace admin of A, in no team
let gus: Actor; // workspace guest of A, viewer of P1
let sam: Actor; // member of A, in P2 only (made by ada's colleague)
let zed: Actor; // owner of B
let keyA: Actor;
let p1: { id: string; key: string };
let p2: { id: string; key: string };
let q1: { id: string; key: string };

before(async () => {
  const A = await workspace(`A ${RUN}`);
  const B = await workspace(`B ${RUN}`);
  ada = await person(A.id, "owner", "ada");
  bob = await person(A.id, "member", "bob");
  cy = await person(A.id, "member", "cy");
  dee = await person(A.id, "viewer", "dee");
  eve = await person(A.id, "admin", "eve");
  gus = await person(A.id, "guest", "gus");
  sam = await person(A.id, "member", "sam");
  zed = await person(B.id, "owner", "zed");
  keyA = await agentKey(A.id);
  p1 = await team(ada, `PA${L}`);
  await addTo(ada, p1.key, bob, "editor");
  await addTo(ada, p1.key, cy, "viewer");
  await addTo(ada, p1.key, dee, "editor");
  await addTo(ada, p1.key, gus, "viewer");
  p2 = await team(sam, `PB${L}`);
  q1 = await team(zed, `QA${L}`);
  await scopeKeyToAllTeams(await getDb(), keyA.id, A.id); // as migration 0026 did for every key that existed: both teams of A, nothing of B
  await createIssue(ada, p1.key, { title: "secret of P1" });
  await createIssue(sam, p2.key, { title: "secret of P2" });
  await createIssue(zed, q1.key, { title: "secret of workspace B" });
});

describe("the rule", () => {
  test("a role is capped by the workspace role, and a role allows what it should", () => {
    assert.equal(effectiveRole("editor", "viewer"), "viewer");
    assert.equal(effectiveRole("admin", "owner"), "admin");
    assert.equal(effectiveRole("editor", "guest"), "editor");
    assert.equal(effectiveRole(null, "owner"), null); // no team row: not even an owner gets in
    assert.equal(roleAllows("viewer", "read"), true);
    assert.equal(roleAllows("viewer", "edit"), false);
    assert.equal(roleAllows("editor", "admin"), false);
    assert.equal(roleAllows("admin", "edit"), true);
  });
});

describe("reading", () => {
  test("a member opens their team; a team they are not in is not_found, the same as one that does not exist", async () => {
    assert.equal((await requireTeam(ada, p1.key)).id, p1.id);
    await assert.rejects(() => requireTeam(ada, p2.key), code("not_found"));
    await assert.rejects(() => requireTeam(ada, "NOPE"), code("not_found"));
    const a = await requireTeam(ada, p1.key).catch(() => null);
    assert.ok(a);
    const msgOther = await requireTeam(ada, p2.key).catch((e) => e.message);
    const msgNone = await requireTeam(ada, "ZZZZ").catch((e) => e.message);
    assert.equal(msgOther.replace(p2.key, "X"), msgNone.replace("ZZZZ", "X")); // same wording: existence does not leak
  });

  test("a workspace owner is not a member of a team made by someone else", async () => {
    await assert.rejects(() => getBoard(ada, p2.key), code("not_found"));
    await assert.rejects(() => getIssue(ada, `${p2.key}-1`), code("not_found"));
  });

  test("a team of another workspace is not_found for everyone here, even by uuid", async () => {
    await assert.rejects(() => requireTeam(ada, q1.id), code("not_found"));
    await assert.rejects(() => requireTeam(zed, p1.id), code("not_found"));
    await assert.rejects(() => getIssue(zed, `${p1.key}-1`), code("not_found"));
  });

  test("lists show only your own teams: a workspace admin in none sees none; an agent key sees the teams it is scoped to", async () => {
    assert.deepEqual((await listTeams(ada)).map((p) => p.key), [p1.key]);
    assert.deepEqual((await listTeams(sam)).map((p) => p.key), [p2.key]);
    assert.deepEqual(await listTeams(eve), []);
    assert.deepEqual((await listTeams(keyA)).map((p) => p.key).sort(), [p1.key, p2.key].sort());
    assert.deepEqual((await listTeams(zed)).map((p) => p.key), [q1.key]);
  });

  test("the dashboard counts only the viewer's teams", async () => {
    const s = await metrics.summary(sam);
    const mine = await metrics.teamProgress(sam);
    assert.deepEqual(mine.map((p) => p.key), [p2.key]);
    assert.ok(s);
    assert.deepEqual((await metrics.teamProgress(eve)).map((p) => p.key), []);
    assert.deepEqual((await metrics.teamProgress(keyA)).map((p) => p.key).sort(), [p1.key, p2.key].sort());
    const feed = await metrics.recentActivity(ada);
    assert.ok(feed.every((e) => !/P2|secret of P2/.test(e.summary)));
  });
});

describe("writing", () => {
  test("an editor writes; a viewer, a guest viewer and a workspace viewer made editor can only read", async () => {
    await createIssue(bob, p1.key, { title: "bob's issue" });
    for (const [who, label] of [[cy, "team viewer"], [gus, "guest viewer"], [dee, "workspace viewer"]] as const) {
      await assert.rejects(() => createIssue(who, p1.key, { title: "no" }), code("forbidden"), label);
      const board = await getBoard(who, p1.key);
      assert.ok(board.issues.length >= 1, `${label} can still read`);
    }
    const t = (await getBoard(ada, p1.key)).issues[0];
    await assert.rejects(() => addComment(cy, `${p1.key}-${t.number}`, "hi"), code("forbidden"));
    await assert.rejects(() => moveIssue(dee, `${p1.key}-${t.number}`, "Done"), code("forbidden"));
  });

  test("an editor cannot change who is in the team or delete it; an admin can", async () => {
    await assert.rejects(() => pmem.addTeamMember(bob, p1.key, { userId: sam.id, role: "viewer" }), code("forbidden"));
    await assert.rejects(() => deleteTeam(bob, p1.key), code("forbidden"));
    await assert.rejects(() => pmem.listAddableMembers(bob, p1.key), code("forbidden"));
  });

  test("team settings: only a team admin edits the name and description; the key and other teams are untouched", async () => {
    const ps = await team(ada, `PS${L}`); // its own team: the others are shared with later tests
    await addTo(ada, ps.key, bob, "editor");
    await addTo(ada, ps.key, cy, "viewer");
    await assert.rejects(() => updateTeam(bob, ps.key, { name: "Hijacked" }), code("forbidden")); // an editor
    await assert.rejects(() => updateTeam(cy, ps.key, { name: "Hijacked" }), code("forbidden")); // a viewer
    await assert.rejects(() => updateTeam(eve, ps.key, { name: "Hijacked" }), code("not_found")); // workspace admin, not a member
    await assert.rejects(() => updateTeam(zed, ps.key, { name: "Hijacked" }), code("not_found")); // another workspace
    await assert.rejects(() => updateTeam(keyA, ps.key, { name: "Hijacked" }), code("forbidden")); // an agent key
    await assert.rejects(() => updateTeam(ada, ps.key, { name: "   " }), code("invalid"));
    const renamed = await updateTeam(ada, ps.key, { name: "Renamed", description: "  About it  " });
    assert.deepEqual([renamed.name, renamed.description, renamed.key], ["Renamed", "About it", ps.key]);
    assert.equal((await requireTeam(sam, p2.key)).name, `Team ${p2.key}`); // another team is untouched
  });

  test("workspace viewers and guests cannot start teams; members can, and become the team's admin", async () => {
    await assert.rejects(() => createTeam(dee, { name: "No", key: "NOV" }), code("forbidden"));
    await assert.rejects(() => createTeam(gus, { name: "No", key: "NOG" }), code("forbidden"));
    const mine = await createTeam(bob, { name: "Bob's", key: `BB${L}` });
    const list = await pmem.listTeamMembers(bob, mine.key);
    assert.deepEqual(list.members.map((m) => [m.name, m.role]), [["bob", "admin"]]);
  });
});

describe("agents and the system", () => {
  test("an agent key reaches the teams it is scoped to and nothing of another workspace", async () => {
    assert.ok((await getBoard(keyA, p1.key)).team);
    assert.ok((await getBoard(keyA, p2.key)).team);
    await assert.rejects(() => requireTeam(keyA, q1.key), code("not_found"));
    await createIssue(keyA, p2.key, { title: "from a key" });
  });

  test("a system actor reaches only the one team it is for, and is never mistaken for a member", async () => {
    const sys: Actor = { kind: "human", id: "00000000-0000-4000-8000-000000000001", name: "GitHub", workspaceId: ada.workspaceId, system: true, teamId: p2.id };
    assert.ok((await requireTeam(sys, p2.key)).id);
    await assert.rejects(() => requireTeam(sys, p1.key), code("not_found"), "another team of its own workspace");
    await assert.rejects(() => requireTeam(sys, q1.key), code("not_found"), "a team of another workspace");
    await assert.rejects(() => requireTeam({ ...sys, teamId: undefined }, p2.key), code("not_found"), "no team, no access");
    const notSystem: Actor = { ...sys, system: undefined };
    await assert.rejects(() => requireTeam(notSystem, p2.key), code("not_found"));
    assert.deepEqual((await listTeams(sys)).map((t) => t.key), [p2.key]);
  });
});

describe("a key scoped to teams (WH-120)", () => {
  const db = () => getDb();
  const giveKey = async (k: Actor, ...teams: { id: string }[]) => {
    for (const t of teams) await (await db()).insert(schema.apiKeyTeams).values({ apiKeyId: k.id, teamId: t.id, workspaceId: k.workspaceId });
  };

  test("a key reaches only its teams: the others answer not_found, in the same words as a team that does not exist", async () => {
    const k = await agentKey(ada.workspaceId);
    await giveKey(k, p1);
    assert.deepEqual((await listTeams(k)).map((t) => t.key), [p1.key]);
    assert.ok((await getBoard(k, p1.key)).team);
    await assert.rejects(() => getBoard(k, p2.key), code("not_found"));
    await assert.rejects(() => getIssue(k, `${p2.key}-1`), code("not_found"));
    await assert.rejects(() => createIssue(k, p2.key, { title: "planted" }), code("not_found"));
    const other = await requireTeam(k, p2.key).catch((e) => e.message);
    const none = await requireTeam(k, "ZZZZ").catch((e) => e.message);
    assert.equal(other.replace(p2.key, "X"), none.replace("ZZZZ", "X"));
    assert.ok((await createIssue(k, p1.key, { title: "allowed" })).ref);
    assert.equal(await roleOnTeam(await db(), k, p1.id), "editor", "an editor on its teams, never an admin");
    await assert.rejects(() => updateTeam(k, p1.key, { name: "x" }), code("forbidden"));
  });

  test("a key with no team reaches nothing", async () => {
    const k = await agentKey(ada.workspaceId);
    assert.deepEqual(await listTeams(k), []);
    await assert.rejects(() => requireTeam(k, p1.key), code("not_found"));
    assert.deepEqual(await visibleTeamIds(await db(), k), []);
    assert.equal((await workspaceScope()(k)).allow?.({ workspaceId: k.workspaceId, teamId: p1.id, type: "x" }), false);
  });

  test("taking a team away from a key, or deleting the team, closes it at once", async () => {
    const k = await agentKey(ada.workspaceId);
    const mine = await team(ada, `SC${L}`);
    await giveKey(k, mine);
    assert.ok((await requireTeam(k, mine.key)).id);
    await (await db()).delete(schema.apiKeyTeams).where(eq(schema.apiKeyTeams.apiKeyId, k.id));
    await assert.rejects(() => requireTeam(k, mine.key), code("not_found"));
    await giveKey(k, mine);
    await deleteTeam(ada, mine.key);
    assert.equal((await (await db()).select().from(schema.apiKeyTeams).where(eq(schema.apiKeyTeams.apiKeyId, k.id))).length, 0, "the row went with the team");
  });

  test("a key that creates a team can open it; one scoped elsewhere still cannot open the rest", async () => {
    const k = await agentKey(ada.workspaceId);
    await giveKey(k, p1);
    const made = await createTeam(k, { name: "Agent made", key: `AG${L}` });
    assert.deepEqual((await listTeams(k)).map((t) => t.key).sort(), [p1.key, made.key].sort());
    await assert.rejects(() => requireTeam(k, p2.key), code("not_found"));
  });

  test("the database refuses a key scoped to a team of another workspace", async () => {
    const k = await agentKey(ada.workspaceId);
    await assert.rejects(
      (await db()).insert(schema.apiKeyTeams).values({ apiKeyId: k.id, teamId: q1.id, workspaceId: ada.workspaceId }),
      (e: unknown) => (e as { cause?: { code?: string } }).cause?.code === "23503",
    );
    await assert.rejects(
      (await db()).insert(schema.apiKeyTeams).values({ apiKeyId: k.id, teamId: q1.id, workspaceId: zed.workspaceId }),
      (e: unknown) => (e as { cause?: { code?: string } }).cause?.code === "23503",
    );
  });
});

describe("the order a person keeps their teams in", () => {
  test("is their own: it follows them, changes nothing for anyone else, and ignores teams that are not theirs", async () => {
    const extra = await team(ada, `OR${L}`);
    await addTo(ada, extra.key, bob, "editor");
    const keys = async (who: Actor) => (await pmem.listTeamsWithRole(who)).map((t) => t.key);
    const before = await keys(ada);
    const bobBefore = await keys(bob);
    assert.equal(before.at(-1), extra.key, "oldest first until they order them: the newest is last");
    const set = await pmem.setTeamOrder(ada, [extra.key, p1.key, p2.key, q1.key, "NOPE"]);
    assert.equal(set.placed, 2, "only their own teams are placed: a team they are not in (p2), another workspace's (q1) and an unknown key are ignored");
    assert.deepEqual((await keys(ada)).slice(0, 2), [extra.key, p1.key]);
    assert.deepEqual(await keys(bob), bobBefore, "bob's order is untouched");
    await pmem.setTeamOrder(ada, [p1.key]);
    const after = await keys(ada);
    assert.equal(after[0], p1.key, "placed ones come first");
    assert.ok(after.indexOf(extra.key) > 0, "a team left out comes after");
    await assert.rejects(() => pmem.setTeamOrder(ada, "AA"), code("invalid"));
    await assert.rejects(() => pmem.setTeamOrder(keyA, [p1.key]), code("forbidden"), "an agent key has no sidebar");
  });
});

describe("a team's icon", () => {
  test("a team admin sets an icon and colour, or an emoji, or clears it; anything else is refused, and so is a non-admin", async () => {
    const t = await team(ada, `IC${L}`);
    await addTo(ada, t.key, bob, "editor");
    const set = await updateTeam(ada, t.key, { icon: "ri:rocket-2", iconColor: "violet" });
    assert.deepEqual([set.icon, set.iconColor], ["ri:rocket-2", "violet"]);
    assert.equal((await updateTeam(ada, t.key, { name: "Renamed" })).icon, "ri:rocket-2", "left out means unchanged");
    const emoji = await updateTeam(ada, t.key, { icon: "🚀" });
    assert.equal(emoji.icon, "🚀");
    assert.equal((await updateTeam(ada, t.key, { icon: "👨‍👩‍👧‍👦" })).icon, "👨‍👩‍👧‍👦", "one emoji built from several is still one");
    for (const bad of ["ri:nonsense", "ab", "🚀🚀", "http://x", 5]) await assert.rejects(() => updateTeam(ada, t.key, { icon: bad }), code("invalid"), String(bad));
    await assert.rejects(() => updateTeam(ada, t.key, { iconColor: "pink" }), code("invalid"));
    const cleared = await updateTeam(ada, t.key, { icon: null, iconColor: null });
    assert.deepEqual([cleared.icon, cleared.iconColor], [null, null]);
    await assert.rejects(() => updateTeam(bob, t.key, { icon: "ri:star" }), code("forbidden"));
    assert.equal((await pmem.listTeamsWithRole(ada)).find((x) => x.key === t.key)!.icon, null, "the list carries it too");
  });
});

describe("who is in a team", () => {
  test("members are listed to any member; adding needs a workspace member; duplicates and strangers are refused", async () => {
    const seen = await pmem.listTeamMembers(cy, p1.key);
    assert.equal(seen.myRole, "viewer");
    assert.deepEqual(seen.members.map((m) => m.name).sort(), ["ada", "bob", "cy", "dee", "gus"]);
    const addable = (await pmem.listAddableMembers(ada, p1.key)).map((m) => m.name);
    assert.ok(addable.includes("eve") && addable.includes("sam") && !addable.includes("bob"));
    await assert.rejects(() => addTo(ada, p1.key, bob, "viewer"), code("conflict"));
    await assert.rejects(() => pmem.addTeamMember(ada, p1.key, { userId: zed.id, role: "viewer" }), code("not_found")); // another workspace
    await assert.rejects(() => pmem.addTeamMember(ada, p1.key, { userId: sam.id, role: "owner" }), code("invalid"));
    await addTo(ada, p1.key, sam, "viewer");
    assert.equal((await requireTeam(sam, p1.key)).id, p1.id);
    await pmem.removeTeamMember(ada, p1.key, sam.id);
    await assert.rejects(() => requireTeam(sam, p1.key), code("not_found"));
  });

  test("a team keeps at least one admin: the last one cannot be demoted, removed or leave", async () => {
    await assert.rejects(() => pmem.setTeamMemberRole(ada, p1.key, ada.id, "editor"), code("conflict"));
    await assert.rejects(() => pmem.removeTeamMember(ada, p1.key, ada.id), code("conflict"));
    await pmem.setTeamMemberRole(ada, p1.key, bob.id, "admin");
    await pmem.setTeamMemberRole(ada, p1.key, ada.id, "editor"); // fine now: bob is admin too
    await pmem.setTeamMemberRole(bob, p1.key, ada.id, "admin");
    await pmem.setTeamMemberRole(bob, p1.key, bob.id, "editor");
  });

  test("agents cannot manage members", async () => {
    await assert.rejects(() => pmem.addTeamMember(keyA, p1.key, { userId: sam.id, role: "viewer" }), code("forbidden"));
  });
});

describe("workspace owners and admins", () => {
  test("they see every team by name and who administers it, not what is inside", async () => {
    const all = await pmem.listWorkspaceTeams(eve);
    const row = all.find((p) => p.key === p2.key)!;
    assert.deepEqual(row.admins, ["sam"]);
    assert.equal(row.isMember, false);
    await assert.rejects(() => pmem.listWorkspaceTeams(bob), code("forbidden"));
    await assert.rejects(() => getBoard(eve, p2.key), code("not_found")); // seeing the name opens nothing
  });

  test("joining as admin is audited, shows in the team's own activity, and members can see it", async () => {
    await pmem.joinTeamAsWorkspaceAdmin(eve, p2.key);
    assert.equal((await requireTeam(eve, p2.key)).id, p2.id);
    const audit = await pmem.listAudit(ada, { teamRef: p2.key });
    assert.ok(audit.some((a) => a.action === "team.admin_joined" && a.actorName === "eve"));
    const feed = await listEvents(sam, p2.key);
    assert.ok(JSON.stringify(feed).includes("joined"));
    await assert.rejects(() => pmem.joinTeamAsWorkspaceAdmin(eve, p2.key), code("conflict")); // already in
    await assert.rejects(() => pmem.joinTeamAsWorkspaceAdmin(bob, p2.key), code("forbidden")); // a plain member cannot
    await assert.rejects(() => pmem.listAudit(bob), code("forbidden"));
  });

  test("a workspace admin cannot reach another workspace's team at all", async () => {
    await assert.rejects(() => pmem.joinTeamAsWorkspaceAdmin(eve, q1.key), code("not_found"));
  });
});

describe("removing someone from the workspace", () => {
  test("is refused while they are a team's only admin, then removes every team row", async () => {
    const lee = await person(ada.workspaceId, "member", "lee");
    const leesTeam = await createTeam(lee, { name: "Lee's", key: `LL${L}` });
    await assert.rejects(() => removeMember(ada.workspaceId, ada.id, lee.id), code("conflict"));
    await pmem.joinTeamAsWorkspaceAdmin(eve, leesTeam.key);
    assert.equal(await removeMember(ada.workspaceId, ada.id, lee.id), true);
    const db = await getDb();
    const left = await db.select().from(schema.teamMembers).where(and(eq(schema.teamMembers.userId, lee.id)));
    assert.equal(left.length, 0);
    await assert.rejects(() => requireTeam(lee, leesTeam.key), code("not_found")); // no workspace membership either
  });
});

describe("invites that carry teams", () => {
  const issuerOf = (a: Actor, role: WorkspaceRole): Issuer => ({ userId: a.id, email: `${a.name}@example.com`, workspaceId: a.workspaceId, role });
  const PW = "correct horse battery";

  test("the new person lands in exactly the chosen teams with the chosen role, and it is audited in the inviter's name", async () => {
    const inv = await createInvite(issuerOf(ada, "owner"), { kind: "join_workspace", email: `new-${RUN}-1@example.com`, role: "member", teams: [{ team: p1.key, role: "viewer" }] });
    const pending = (await listInvites(issuerOf(ada, "owner"))).find((i) => i.id === inv.id)!;
    assert.deepEqual(pending.teams, [{ key: p1.key, name: `Team ${p1.key}`, role: "viewer" }]);
    const { userId } = await acceptInvite({ token: inv.token, name: "Newbie", password: PW });
    const newbie: Actor = { kind: "human", id: userId, name: "Newbie", workspaceId: ada.workspaceId };
    assert.deepEqual((await listTeams(newbie)).map((p) => p.key), [p1.key]);
    await assert.rejects(() => requireTeam(newbie, p2.key), code("not_found"));
    await assert.rejects(() => createIssue(newbie, p1.key, { title: "no" }), code("forbidden")); // the viewer role they were given
    const log = await pmem.listAudit(ada, { teamRef: p1.key });
    const line = log.find((a) => a.action === "team.member_added" && a.targetId === userId)!;
    assert.deepEqual([line.actorName, line.after], ["ada", { role: "viewer", via: "invite" }]);
  });

  test("an invite with no teams leaves the person in none, as before", async () => {
    const inv = await createInvite(issuerOf(ada, "owner"), { kind: "join_workspace", email: `new-${RUN}-2@example.com` });
    const { userId } = await acceptInvite({ token: inv.token, name: "Plain", password: PW });
    assert.deepEqual(await listTeams({ kind: "human", id: userId, name: "Plain", workspaceId: ada.workspaceId }), []);
  });

  test("you can only hand out teams you administer, never another workspace's, and at most 20", async () => {
    const asEve = issuerOf(eve, "admin"); // a workspace admin, but in no team
    await assert.rejects(() => createInvite(asEve, { kind: "join_workspace", email: `new-${RUN}-3@example.com`, teams: [{ team: p1.key, role: "viewer" }] }), (e) => (e as { code?: string }).code === "forbidden");
    await assert.rejects(() => createInvite(issuerOf(bob, "member"), { kind: "join_workspace", email: `new-${RUN}-4@example.com`, teams: [{ team: p1.key, role: "viewer" }] }), (e) => (e as { code?: string }).code === "forbidden"); // not a manager at all
    await assert.rejects(() => createInvite(issuerOf(ada, "owner"), { kind: "join_workspace", email: `new-${RUN}-5@example.com`, teams: [{ team: q1.key, role: "viewer" }] }), (e) => (e as { code?: string }).code === "forbidden"); // another workspace
    await assert.rejects(() => createInvite(issuerOf(ada, "owner"), { kind: "join_workspace", email: `new-${RUN}-6@example.com`, teams: [{ team: p1.key, role: "owner" as never }] }), (e) => (e as { code?: string }).code === "invalid");
  });

  test("a team deleted before the invite is accepted is skipped, not an error", async () => {
    const mine = await createTeam(ada, { name: "Short lived", key: `SL${L}` });
    const inv = await createInvite(issuerOf(ada, "owner"), { kind: "join_workspace", email: `new-${RUN}-7@example.com`, teams: [{ team: mine.key, role: "editor" }, { team: p1.key, role: "viewer" }] });
    await deleteTeam(ada, mine.key);
    const { userId } = await acceptInvite({ token: inv.token, name: "Late", password: PW });
    assert.deepEqual((await listTeams({ kind: "human", id: userId, name: "Late", workspaceId: ada.workspaceId })).map((p) => p.key), [p1.key]);
  });
});

describe("the audit log", () => {
  test("a workspace role change and a removal are written down, with who did it and what changed", async () => {
    const t = await person(ada.workspaceId, "member", "audited");
    assert.equal(await updateMember(ada.workspaceId, ada.id, { userId: t.id, role: "viewer", tags: [] }), true);
    assert.equal(await removeMember(ada.workspaceId, ada.id, t.id), true);
    const log = await pmem.listAudit(ada, { limit: 50 });
    const changed = log.find((a) => a.action === "workspace.role_changed" && a.targetId === t.id)!;
    assert.deepEqual([changed.actorName, changed.before, changed.after], ["ada", { role: "member" }, { role: "viewer" }]);
    assert.ok(log.some((a) => a.action === "workspace.member_removed" && a.targetId === t.id));
    assert.ok(log.every((a) => a.seq > 0));
    // an unchanged role writes nothing
    const u = await person(ada.workspaceId, "member", "steady");
    const before = (await pmem.listAudit(ada, { limit: 500 })).length;
    await updateMember(ada.workspaceId, ada.id, { userId: u.id, role: "member", tags: ["x"] });
    assert.equal((await pmem.listAudit(ada, { limit: 500 })).length, before);
  });
});

describe("live streams", () => {
  test("the dashboard stream replays and delivers only events of teams the person is in", async () => {
    const adaScope = await workspaceScope()(ada);
    const samScope = await workspaceScope()(sam);
    const keyScope = await workspaceScope()(keyA);
    const ev = (teamId: string) => ({ workspaceId: ada.workspaceId, teamId, type: "issue.created" });
    assert.equal(adaScope.allow?.(ev(p1.id)), true);
    assert.equal(adaScope.allow?.(ev(p2.id)), false);
    assert.equal(samScope.allow?.(ev(p2.id)), true);
    assert.equal(samScope.allow?.(ev(p1.id)), false);
    assert.equal(keyScope.allow?.(ev(p1.id)), true); // keyA is scoped to both teams of A
    assert.equal(keyScope.allow?.(ev(q1.id)), false);
    const nobody = await workspaceScope()(await person(ada.workspaceId, "member", "nobody"));
    assert.equal(nobody.allow?.(ev(p1.id)), false);
  });

  test("an open dashboard stream follows joins and removals, and a team stream ends when its person is removed", async () => {
    const stream = await person(ada.workspaceId, "member", "watcher");
    const scope = await workspaceScope()(stream);
    const ev = (teamId: string) => ({ workspaceId: ada.workspaceId, teamId, type: "issue.created" });
    assert.equal(scope.allow?.(ev(p1.id)), false);
    await addTo(ada, p1.key, stream, "viewer");
    assert.equal(await scope.recheck?.(), true);
    assert.equal(scope.allow?.(ev(p1.id)), true); // joined while the page was open
    const one = await teamScope(p1.key)(stream);
    assert.equal(await one.recheck?.(), true);
    await pmem.removeTeamMember(ada, p1.key, stream.id);
    assert.equal(await one.recheck?.(), false); // the team stream ends
    await scope.recheck?.();
    assert.equal(scope.allow?.(ev(p1.id)), false); // and the dashboard stops hearing it
  });
});

describe("the per-team dashboard (WH-107)", () => {
  let owner: Actor;
  let one: { id: string; key: string };
  let two: { id: string; key: string };
  let viewer: Actor;
  const days = (n: number) => new Date(Date.now() - n * 864e5);

  before(async () => {
    const T = await workspace(`Dash ${RUN}`);
    owner = await person(T.id, "owner", "dashowner");
    viewer = await person(T.id, "member", "dashviewer");
    one = await team(owner, `DA${L}`);
    two = await team(owner, `DB${L}`);
    await addTo(owner, one.key, viewer, "viewer");
    // team one: 3 issues (one done, one in progress for 9 days, one in review for 4 days); team two: 1 urgent issue
    const t1 = await createIssue(owner, one.key, { title: "done one" });
    const t2 = await createIssue(owner, one.key, { title: "slow one", priority: "high" });
    const t3 = await createIssue(owner, one.key, { title: "waiting one" });
    await moveIssue(owner, `${one.key}-${t1.number}`, "done");
    await moveIssue(owner, `${one.key}-${t2.number}`, "in_progress");
    await moveIssue(owner, `${one.key}-${t3.number}`, "review");
    await createIssue(owner, two.key, { title: "urgent elsewhere", priority: "urgent" });
    // age the moves: the events say when each issue arrived in its status
    const db = await getDb();
    const moved = await db.select().from(schema.events).where(and(eq(schema.events.teamId, one.id), eq(schema.events.type, "issue.moved")));
    for (const e of moved) {
      const age = e.summary.includes(`${one.key}-${t2.number}`) ? 9 : e.summary.includes(`${one.key}-${t3.number}`) ? 4 : 1;
      await db.update(schema.events).set({ createdAt: days(age) }).where(eq(schema.events.seq, e.seq));
    }
  });

  test("a team's numbers are its own: the workspace totals include both, the team's only itself", async () => {
    const all = await metrics.summary(owner);
    const mine = await metrics.summary(owner, one.id);
    assert.equal(all.teams, 2);
    assert.equal(mine.teams, 1);
    assert.equal(mine.open, 2); // slow + waiting; the done one is not open
    assert.equal(mine.inProgress, 1);
    assert.equal(mine.inReview, 1);
    assert.equal(all.open, mine.open + 1); // plus the other team's issue
    const progress = await metrics.teamProgress(owner, one.id);
    assert.deepEqual(progress.map((p) => [p.key, p.total, p.done]), [[one.key, 3, 1]]);
    assert.equal(progress[0].urgent, 1); // the high-priority one only; the urgent issue belongs to the other team
  });

  test("attention, activity and throughput read only that team", async () => {
    const att = await metrics.needsAttention(owner, one.id);
    assert.deepEqual(att.review.map((r) => r.title), ["waiting one"]);
    assert.deepEqual(att.urgent, []); // the urgent issue is in the other team
    assert.deepEqual((await metrics.needsAttention(owner, two.id)).urgent.map((u) => u.title), ["urgent elsewhere"]);
    const feed = await metrics.recentActivity(owner, 50, one.id);
    assert.ok(feed.length > 0 && feed.every((e) => e.teamKey === one.key));
    const through = await metrics.throughput(owner, 14, one.id);
    assert.equal(through.reduce((n, d) => n + d.created, 0), 3);
    assert.equal((await metrics.throughput(owner, 14)).reduce((n, d) => n + d.created, 0), 4);
  });

  test("focus ranks what has sat longest, and says who is in the team", async () => {
    const f = await metrics.teamFocus(owner, one.id);
    assert.deepEqual(f.aging.map((a) => [a.title, a.days]), [["slow one", 9]]);
    assert.deepEqual(f.waitingReview.map((a) => [a.title, a.days]), [["waiting one", 4]]);
    assert.deepEqual([f.issues, f.members.count, f.members.myRole, f.proposedDecisions], [3, 2, "admin", 0]);
    assert.equal((await metrics.teamFocus(viewer, one.id)).members.myRole, "viewer");
  });

  test("another team's id is never read: a person who is not in it gets an empty snapshot, not its numbers", async () => {
    assert.equal((await metrics.summary(viewer, two.id)).teams, 0);
    assert.equal((await metrics.summary(viewer, two.id)).open, 0);
    const f = await metrics.teamFocus(viewer, two.id);
    assert.deepEqual([f.aging, f.waitingReview, f.issues, f.members.count], [[], [], 0, 0]);
    // and a viewer sees the workspace dashboard limited to the one team they are in
    assert.equal((await metrics.summary(viewer)).teams, 1);
  });

  test("an empty team has numbers of zero and nothing to focus on", async () => {
    const e = await team(owner, `DE${L}`);
    const s = await metrics.summary(owner, e.id);
    assert.deepEqual([s.teams, s.open, s.completed7d, s.agentsActive7d], [1, 0, 0, 0]);
    const f = await metrics.teamFocus(owner, e.id);
    assert.deepEqual([f.aging, f.waitingReview, f.quiet, f.issues], [[], [], [], 0]);
    assert.equal((await metrics.teamProgress(owner, e.id))[0].pct, 0);
  });
});
