/**
 * A team's statuses, managed from its settings: add, rename, recolour, default, reorder and delete, with the rules that keep a board
 * usable. Runs on an in-memory PGlite (`pnpm test`), or a real Postgres with TEST_DATABASE_URL.
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
import { getDb, schema } from "../db";
import type { Actor } from "./access";
import { scopeKeyToAllTeams } from "./key-scope";
import * as svc from "./service";
import * as st from "./statuses";
import { addTeamMember } from "./team-members";

let db: Awaited<ReturnType<typeof getDb>>;
let owner: Actor; // admin of both teams
let editor: Actor; // an editor of team SA
let agent: Actor;
let stranger: Actor; // in another workspace
const code = (c: svc.ServiceError["code"]) => (e: unknown) => e instanceof svc.ServiceError && e.code === c;
const names = async (key = "SA") => (await st.listStatuses(owner, key)).map((s) => s.name);
const byName = async (name: string, key = "SA") => (await st.listStatuses(owner, key)).find((s) => s.name === name)!;

before(async () => {
  db = await getDb();
  const [w] = await db.insert(schema.workspaces).values({ name: "Status workspace" }).returning();
  const [w2] = await db.insert(schema.workspaces).values({ name: "Other workspace" }).returning();
  const mk = async (name: string, ws: { id: string }, role: "owner" | "member"): Promise<Actor> => {
    const [u] = await db.insert(schema.users).values({ email: `${name}-${Math.random().toString(16).slice(2, 8)}@example.com`, name, passwordHash: "x" }).returning();
    await db.insert(schema.memberships).values({ userId: u.id, workspaceId: ws.id, role });
    return { kind: "human", id: u.id, name, workspaceId: ws.id };
  };
  owner = await mk("owner", w, "owner");
  editor = await mk("editor", w, "member");
  stranger = await mk("stranger", w2, "owner");
  await svc.createTeam(owner, { name: "Alpha", key: "SA" });
  await svc.createTeam(owner, { name: "Beta", key: "SB" });
  await addTeamMember(owner, "SA", { userId: editor.id, role: "editor" });
  const [k] = await db.insert(schema.apiKeys).values({ workspaceId: w.id, name: "worker", prefix: "wh_", keyHash: "worker-st" }).returning();
  agent = { kind: "agent", id: k.id, name: "worker", workspaceId: w.id };
  await scopeKeyToAllTeams(db, agent.id, w.id);
});

describe("listing", () => {
  test("a new team's statuses, in order, with their issue counts, role and default", async () => {
    const list = await st.listStatuses(owner, "SA");
    assert.deepEqual(list.map((s) => [s.name, s.role, s.isDefault, s.color, s.issueCount]), [
      ["Backlog", "backlog", true, null, 0], ["Todo", "todo", true, null, 0], ["In Progress", "in_progress", true, null, 0],
      ["Review", "review", true, null, 0], ["Done", "done", true, null, 0], ["Canceled", "canceled", true, null, 0],
    ]);
    await svc.createIssue(owner, "SA", { title: "counted", status: "todo" });
    assert.equal((await byName("Todo")).issueCount, 1);
    assert.equal((await st.listStatuses(editor, "SA")).length, 6, "an editor can read them");
  });
});

describe("who can change statuses", () => {
  test("team admins can; an editor, an agent and another workspace cannot", async () => {
    await assert.rejects(st.createStatus(editor, "SA", { name: "Nope", role: "todo" }), code("forbidden"));
    await assert.rejects(st.createStatus(agent, "SA", { name: "Nope", role: "todo" }), code("forbidden"));
    await assert.rejects(st.createStatus(stranger, "SA", { name: "Nope", role: "todo" }), code("not_found"));
    await assert.rejects(st.updateStatus(editor, "SA", "Todo", { name: "Nope" }), code("forbidden"));
    await assert.rejects(st.reorderStatuses(editor, "SA", []), code("forbidden"));
    await assert.rejects(st.deleteStatus(editor, "SA", "Todo"), code("forbidden"));
    await assert.rejects(st.updateStatus(stranger, "SA", "Todo", { name: "Nope" }), code("not_found"));
    await assert.rejects(st.listStatuses(stranger, "SA"), code("not_found"));
    assert.deepEqual(await names(), ["Backlog", "Todo", "In Progress", "Review", "Done", "Canceled"]);
  });
});

describe("adding", () => {
  test("a status goes at the end of its role's group, and is not the default when its role has one", async () => {
    const s = await st.createStatus(owner, "SA", { name: "  Ready for QA  ", role: "in_progress", color: "violet" });
    assert.deepEqual([s.name, s.role, s.isDefault, s.color, s.issueCount], ["Ready for QA", "in_progress", false, "violet", 0]);
    assert.deepEqual(await names(), ["Backlog", "Todo", "In Progress", "Ready for QA", "Review", "Done", "Canceled"]);
    const late = await st.createStatus(owner, "SA", { name: "Shipped", role: "done" });
    assert.deepEqual(await names(), ["Backlog", "Todo", "In Progress", "Ready for QA", "Review", "Done", "Shipped", "Canceled"]);
    assert.equal(late.isDefault, false);
    const early = await st.createStatus(owner, "SA", { name: "Icebox", role: "backlog" });
    assert.equal((await names())[1], "Icebox", "after Backlog, before Todo");
    assert.equal(early.isDefault, false);
  });

  test("a name is needed, at most 40 characters, and unique in the team whatever its case", async () => {
    for (const name of [undefined, "", "   ", 3, "x".repeat(41)]) {
      await assert.rejects(st.createStatus(owner, "SA", { name, role: "todo" }), (e: unknown) => code("invalid")(e) && "name" in ((e as svc.ServiceError).details as { fields: object }).fields, String(name));
    }
    await assert.rejects(st.createStatus(owner, "SA", { name: "BACKLOG", role: "todo" }), code("conflict"));
    // the same name in another team is fine
    assert.equal((await st.createStatus(owner, "SB", { name: "Ready for QA", role: "todo" })).name, "Ready for QA");
  });

  test("a role is needed and must be one of the roles; a colour must be from the palette", async () => {
    for (const role of [undefined, null, "", "blocked", 3]) await assert.rejects(st.createStatus(owner, "SA", { name: "R", role }), code("invalid"), String(role));
    await assert.rejects(st.createStatus(owner, "SA", { name: "C", role: "todo", color: "pink" }), code("invalid"));
  });

  test("a role that has no status yet (review was deleted) gets its first one as the default", async () => {
    await svc.createTeam(owner, { name: "Gamma", key: "SG" });
    await st.deleteStatus(owner, "SG", "Review");
    const again = await st.createStatus(owner, "SG", { name: "Peer review", role: "review" });
    assert.equal(again.isDefault, true);
    assert.deepEqual((await st.listStatuses(owner, "SG")).map((s) => s.name), ["Backlog", "Todo", "In Progress", "Peer review", "Done", "Canceled"]);
  });
});

describe("editing", () => {
  test("rename and recolour by id or by name; the same values change nothing", async () => {
    const todo = await byName("Todo");
    const renamed = await st.updateStatus(owner, "SA", todo.id, { name: "Up next", color: "amber" });
    assert.deepEqual([renamed.name, renamed.color, renamed.role], ["Up next", "amber", "todo"]);
    assert.equal((await st.updateStatus(owner, "SA", "up next", { name: "Up next", color: "amber" })).name, "Up next");
    const cleared = await st.updateStatus(owner, "SA", "Up next", { color: null });
    assert.equal(cleared.color, null);
    await st.updateStatus(owner, "SA", "Up next", { name: "Todo" });
    assert.equal((await svc.createIssue(owner, "SA", { title: "by role still", status: "todo" })).status, "Todo");
  });

  test("a rename cannot take another status's name, and a case change of its own name is fine", async () => {
    await assert.rejects(st.updateStatus(owner, "SA", "Todo", { name: "done" }), code("conflict"));
    assert.equal((await st.updateStatus(owner, "SA", "Todo", { name: "TODO" })).name, "TODO");
    await st.updateStatus(owner, "SA", "TODO", { name: "Todo" });
  });

  test("a role cannot change, and an unknown status is not found", async () => {
    await assert.rejects(st.updateStatus(owner, "SA", "Todo", { role: "done" }), (e: unknown) => code("invalid")(e) && /role cannot change/.test((e as Error).message));
    await st.updateStatus(owner, "SA", "Todo", { role: "todo" }); // saying the role it has is no change
    await assert.rejects(st.updateStatus(owner, "SA", "Nowhere", { name: "x" }), code("not_found"));
  });

  test("another team's status id is not found", async () => {
    const theirs = await byName("Todo", "SB");
    await assert.rejects(st.updateStatus(owner, "SA", theirs.id, { name: "Hijacked" }), code("not_found"));
    await assert.rejects(st.deleteStatus(owner, "SA", theirs.id), code("not_found"));
  });
});

describe("the default of a role", () => {
  test("making another status the default moves it; only true is accepted; a role-less status cannot be one", async () => {
    const qa = await byName("Ready for QA");
    assert.equal(qa.isDefault, false);
    const made = await st.updateStatus(owner, "SA", qa.id, { isDefault: true });
    assert.equal(made.isDefault, true);
    const list = await st.listStatuses(owner, "SA");
    assert.deepEqual(list.filter((s) => s.role === "in_progress").map((s) => [s.name, s.isDefault]), [["In Progress", false], ["Ready for QA", true]]);
    assert.equal((await svc.moveIssue(owner, (await svc.createIssue(owner, "SA", { title: "to progress" })).ref, "in_progress")).status, "Ready for QA", "a move by role follows the default");
    await assert.rejects(st.updateStatus(owner, "SA", "In Progress", { isDefault: false }), code("invalid"));
    await st.updateStatus(owner, "SA", "In Progress", { isDefault: true });
    assert.equal((await byName("Ready for QA")).isDefault, false);
    await db.insert(schema.statuses).values({ teamId: (await svc.requireTeam(owner, "SA")).id, workspaceId: owner.workspaceId, name: "Legacy", position: 99999, role: null });
    await assert.rejects(st.updateStatus(owner, "SA", "Legacy", { isDefault: true }), code("invalid"));
  });
});

describe("ordering", () => {
  test("the whole list is given in the order wanted, and the board follows it", async () => {
    const before = await st.listStatuses(owner, "SB");
    const ids = before.map((s) => s.id);
    // swap the two statuses of the same role-group the team has (Todo and "Ready for QA" are both todo in SB)
    const todo = before.findIndex((s) => s.name === "Todo");
    const qa = before.findIndex((s) => s.name === "Ready for QA");
    [ids[todo], ids[qa]] = [ids[qa], ids[todo]];
    const after = await st.reorderStatuses(owner, "SB", ids);
    assert.deepEqual(after.map((s) => s.id), ids);
    assert.deepEqual((await svc.getBoard(owner, "SB")).statuses.map((s) => s.id), ids, "the board reads the same order");
  });

  test("it must name every status once, and keep the roles grouped in order", async () => {
    const ids = (await st.listStatuses(owner, "SA")).map((s) => s.id);
    for (const bad of [null, "x", [1], ids.slice(1), [...ids, ids[0]], [...ids.slice(1), "nope"], [ids[0], ids[0], ...ids.slice(2)]]) {
      await assert.rejects(st.reorderStatuses(owner, "SA", bad), code("invalid"), JSON.stringify(bad)?.slice(0, 40));
    }
    const list = await st.listStatuses(owner, "SA");
    const done = list.findIndex((s) => s.name === "Done");
    const wrong = list.map((s) => s.id);
    [wrong[0], wrong[done]] = [wrong[done], wrong[0]]; // Done first: a later role ahead of Backlog
    await assert.rejects(st.reorderStatuses(owner, "SA", wrong), (e: unknown) => code("invalid")(e) && /grouped by role/.test((e as Error).message));
    assert.deepEqual((await st.listStatuses(owner, "SA")).map((s) => s.id), list.map((s) => s.id), "nothing changed");
  });
});

describe("deleting", () => {
  test("an empty status goes; if it was its role's default the next one of the role takes over", async () => {
    await svc.createTeam(owner, { name: "Delta", key: "SD" });
    const second = await st.createStatus(owner, "SD", { name: "Doing more", role: "in_progress" });
    assert.equal(second.isDefault, false);
    const gone = await st.deleteStatus(owner, "SD", "In Progress");
    assert.deepEqual(gone, { ok: true, deleted: "In Progress", moved: 0 });
    assert.equal((await st.listStatuses(owner, "SD")).find((s) => s.name === "Doing more")!.isDefault, true);
  });

  test("a status with issues needs somewhere to move them, which keeps their order and bumps their version", async () => {
    await svc.createTeam(owner, { name: "Epsilon", key: "SE" });
    await st.createStatus(owner, "SE", { name: "Blocked", role: "todo" });
    const a = await svc.createIssue(owner, "SE", { title: "a", status: "Blocked" });
    const b = await svc.createIssue(owner, "SE", { title: "b", status: "Blocked" });
    const c = await svc.createIssue(owner, "SE", { title: "c", status: "Todo" });
    await assert.rejects(st.deleteStatus(owner, "SE", "Blocked"), (e: unknown) => code("conflict")(e) && (e as svc.ServiceError).details && (e as { details: { issues: number } }).details.issues === 2);
    await assert.rejects(st.deleteStatus(owner, "SE", "Blocked", "Blocked"), code("invalid"));
    await assert.rejects(st.deleteStatus(owner, "SE", "Blocked", "Nowhere"), code("not_found"));
    assert.equal((await svc.getIssue(owner, a.ref)).issue.status, "Blocked", "nothing moved by the refusals");
    const res = await st.deleteStatus(owner, "SE", "Blocked", "Todo");
    assert.equal(res.moved, 2);
    const board = await svc.getBoard(owner, "SE");
    const todoId = board.statuses.find((s) => s.name === "Todo")!.id;
    const inTodo = board.issues.filter((t) => t.statusId === todoId).sort((x, y) => x.position - y.position).map((t) => t.title);
    assert.deepEqual(inTodo, ["c", "a", "b"], "they land after what was there, in their own order");
    assert.equal((await svc.getIssue(owner, a.ref)).issue.version, a.version + 1);
    assert.equal((await svc.getIssue(owner, c.ref)).issue.version, c.version, "an issue that did not move is untouched");
    assert.equal((await svc.getIssue(owner, b.ref)).issue.status, "Todo");
  });

  test("the last status of a required role cannot be deleted; review can", async () => {
    await svc.createTeam(owner, { name: "Zeta", key: "SZ" });
    for (const name of ["Backlog", "Todo", "In Progress", "Done", "Canceled"]) {
      await assert.rejects(st.deleteStatus(owner, "SZ", name), (e: unknown) => code("conflict")(e) && /last .* status/.test((e as Error).message), name);
    }
    assert.equal((await st.deleteStatus(owner, "SZ", "Review")).moved, 0);
  });

  test("the database will not delete a status that still has issues, even if the service were wrong", async () => {
    const team = await svc.requireTeam(owner, "SA");
    const i = await svc.createIssue(owner, "SA", { title: "guarded", status: "Backlog" });
    const [backlog] = await db.select().from(schema.statuses).where(and(eq(schema.statuses.teamId, team.id), eq(schema.statuses.name, "Backlog")));
    await assert.rejects(db.delete(schema.statuses).where(eq(schema.statuses.id, backlog.id)), (e: unknown) => (e as { cause?: { code?: string } }).cause?.code === "23503");
    assert.equal((await svc.getIssue(owner, i.ref)).issue.status, "Backlog");
  });

  test("deleting a team still works with statuses and issues in it", async () => {
    await svc.createTeam(owner, { name: "Eta", key: "SH" });
    await svc.createIssue(owner, "SH", { title: "goes with the team" });
    assert.deepEqual(await svc.deleteTeam(owner, "SH"), { ok: true, deleted: "SH" });
  });
});

describe("what is recorded", () => {
  test("each change is in the team's activity and the audit log", async () => {
    await svc.createTeam(owner, { name: "Theta", key: "ST" });
    const made = await st.createStatus(owner, "ST", { name: "Spec", role: "backlog" });
    await st.updateStatus(owner, "ST", made.id, { name: "Specs" });
    await st.deleteStatus(owner, "ST", made.id);
    const team = await svc.requireTeam(owner, "ST");
    const types = (await db.select().from(schema.events).where(and(eq(schema.events.teamId, team.id), eq(schema.events.entity, "status")))).map((e) => e.type);
    assert.deepEqual(types, ["status.created", "status.updated", "status.deleted"]);
    const audited = (await db.select().from(schema.auditEvents).where(eq(schema.auditEvents.teamId, team.id))).map((r) => r.action).filter((a) => a.startsWith("status."));
    assert.deepEqual(audited, ["status.created", "status.updated", "status.deleted"]);
  });
});
