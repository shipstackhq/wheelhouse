/**
 * Tenant integrity in the database (WH-113): a team-scoped row cannot name another workspace's team, a team member is a
 * workspace member, and an assignee is a member of the ticket's team. Runs on an in-memory PGlite (`pnpm test`), or a real
 * Postgres with TEST_DATABASE_URL.
 */
if (process.env.TEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
} else {
  process.env.PGLITE_DIR = "memory://";
  delete process.env.DATABASE_URL;
}

import { before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { and, eq, sql } from "drizzle-orm";
import { getDb, schema } from "../db";
import type { WorkspaceRole } from "../db/schema";
import type { Actor } from "./access";
import * as svc from "./service";
import * as pmem from "./team-members";

const RUN = Math.random().toString(16).slice(2, 8);
const L = RUN.replace(/[0-9]/g, (c) => "ghijklmnop"[Number(c)]).slice(0, 2).toUpperCase();
let n = 0;

async function workspace(name: string) {
  const db = await getDb();
  const [w] = await db.insert(schema.workspaces).values({ name }).returning();
  return w;
}
async function person(workspaceId: string, role: WorkspaceRole, name: string): Promise<Actor> {
  const db = await getDb();
  const [u] = await db.insert(schema.users).values({ email: `${name}-${RUN}-${++n}@example.com`, name, passwordHash: "x" }).returning();
  await db.insert(schema.memberships).values({ userId: u.id, workspaceId, role });
  return { kind: "human", id: u.id, name, workspaceId };
}

/** Postgres says why a statement was refused in `cause`; drizzle wraps it. */
const refused = (kind: "23503" | "23502") => (e: unknown) => (e as { cause?: { code?: string } }).cause?.code === kind;

let wsA: { id: string };
let wsB: { id: string };
let ada: Actor; // owner of A, admin of team A1
let bob: Actor; // member of A, editor of A1
let cy: Actor; // member of A, in no team
let bea: Actor; // owner of B
let a1: { id: string; key: string; workspaceId: string };

before(async () => {
  wsA = await workspace(`scope A ${RUN}`);
  wsB = await workspace(`scope B ${RUN}`);
  ada = await person(wsA.id, "owner", "ada");
  bob = await person(wsA.id, "member", "bob");
  cy = await person(wsA.id, "member", "cy");
  bea = await person(wsB.id, "owner", "bea");
  a1 = await svc.createTeam(ada, { name: "A one", key: `${L}A` });
  await svc.createTeam(bea, { name: "B one", key: `${L}B` });
  await pmem.addTeamMember(ada, a1.key, { userId: bob.id, role: "editor" });
});

describe("a row names its team's own workspace", () => {
  // One insert per table, each with the right team and the other workspace. Every one must be refused.
  const wrong = () => ({ teamId: a1.id, workspaceId: wsB.id });

  test("teams: (id, workspace_id) is unique, so the pair can be a foreign key", async () => {
    const db = await getDb();
    const [t] = await db.select({ id: schema.teams.id, workspaceId: schema.teams.workspaceId }).from(schema.teams).where(eq(schema.teams.id, a1.id));
    assert.deepEqual(t, { id: a1.id, workspaceId: wsA.id });
    await assert.rejects(db.execute(sql`insert into teams (id, workspace_id, key, name) values (${a1.id}, ${wsB.id}, 'ZZZ', 'dup')`), (e: unknown) => (e as { cause?: { code?: string } }).cause?.code === "23505");
  });

  const cases: [string, () => Promise<unknown>][] = [
    ["columns", async () => (await getDb()).insert(schema.columns).values({ ...wrong(), name: "x", position: 1 })],
    ["tickets", async () => {
      const db = await getDb();
      const [col] = await db.select().from(schema.columns).where(eq(schema.columns.teamId, a1.id));
      return db.insert(schema.tickets).values({ ...wrong(), columnId: col.id, number: 999, title: "x", position: 1, createdByKind: "human" });
    }],
    ["nodes", async () => (await getDb()).insert(schema.nodes).values({ ...wrong(), layer: "system", kind: "service", name: "x" })],
    ["flows", async () => (await getDb()).insert(schema.flows).values({ ...wrong(), name: "x" })],
    ["decisions", async () => (await getDb()).insert(schema.decisions).values({ ...wrong(), number: 999, title: "x", authorKind: "human", authorName: "x" })],
    ["terms", async () => (await getDb()).insert(schema.terms).values({ ...wrong(), term: "x", definition: "x" })],
    ["docs", async () => (await getDb()).insert(schema.docs).values({ ...wrong(), slug: "x", title: "x", createdByKind: "human", updatedByKind: "human", position: 0 })],
    ["repositories", async () => (await getDb()).insert(schema.repositories).values({ ...wrong(), displayName: "x", role: "x", slug: "x" })],
    ["team_files", async () => (await getDb()).insert(schema.teamFiles).values({ ...wrong(), path: "x", hash: "x" })],
    ["team_members", async () => (await getDb()).insert(schema.teamMembers).values({ ...wrong(), userId: cy.id, role: "editor" })],
  ];
  for (const [table, attempt] of cases) {
    test(`${table}: a row with the team of one workspace and the id of another is refused`, async () => {
      await assert.rejects(attempt(), refused("23503"));
    });
  }

  test("a row cannot be moved to another workspace while its team stays", async () => {
    const db = await getDb();
    await assert.rejects(db.update(schema.columns).set({ workspaceId: wsB.id }).where(eq(schema.columns.teamId, a1.id)), refused("23503"));
  });

  test("deleting a team removes its rows through the same key", async () => {
    const t = await svc.createTeam(ada, { name: "Short lived", key: `${L}S` });
    await svc.deleteTeam(ada, t.key);
    const db = await getDb();
    assert.equal((await db.select().from(schema.columns).where(eq(schema.columns.teamId, t.id))).length, 0);
  });
});

describe("a team member is a workspace member", () => {
  test("someone from another workspace cannot be put on a team", async () => {
    const db = await getDb();
    await assert.rejects(db.insert(schema.teamMembers).values({ teamId: a1.id, workspaceId: wsA.id, userId: bea.id, role: "editor" }), refused("23503"));
    await assert.rejects(pmem.addTeamMember(ada, a1.key, { userId: bea.id, role: "editor" }), (e: unknown) => e instanceof svc.ServiceError);
  });

  test("a person who leaves the workspace leaves every team in it", async () => {
    const dan = await person(wsA.id, "member", "dan");
    await pmem.addTeamMember(ada, a1.key, { userId: dan.id, role: "editor" });
    const db = await getDb();
    const rows = () => db.select().from(schema.teamMembers).where(eq(schema.teamMembers.userId, dan.id));
    assert.equal((await rows()).length, 1);
    await db.delete(schema.memberships).where(and(eq(schema.memberships.userId, dan.id), eq(schema.memberships.workspaceId, wsA.id)));
    assert.equal((await rows()).length, 0);
  });
});

describe("an assignee is a member of the ticket's team", () => {
  test("a team member can be assigned; a workspace member who is not on the team cannot", async () => {
    const t = await svc.createTicket(ada, a1.key, { title: "Assign me", assigneeId: bob.id });
    assert.equal(t.assigneeId, bob.id);
    await assert.rejects(svc.createTicket(ada, a1.key, { title: "Nope", assigneeId: cy.id }), (e: unknown) => e instanceof svc.ServiceError && e.code === "invalid" && /member of this team/.test(e.message));
    await assert.rejects(svc.updateTicket(ada, t.ref, { assigneeId: cy.id }), (e: unknown) => e instanceof svc.ServiceError && e.code === "invalid");
    await assert.rejects(svc.updateTicket(ada, t.ref, { assigneeId: bea.id }), (e: unknown) => e instanceof svc.ServiceError && e.code === "invalid");
  });

  test("the database refuses a non-member assignee even when the service is bypassed", async () => {
    const t = await svc.createTicket(ada, a1.key, { title: "Direct" });
    const db = await getDb();
    await assert.rejects(db.update(schema.tickets).set({ assigneeId: cy.id }).where(eq(schema.tickets.id, t.id)), refused("23503"));
  });

  test("removing someone from a team unassigns their tickets there and nothing else", async () => {
    const eli = await person(wsA.id, "member", "eli");
    await pmem.addTeamMember(ada, a1.key, { userId: eli.id, role: "editor" });
    const mine = await svc.createTicket(ada, a1.key, { title: "Eli's", assigneeId: eli.id });
    const other = await svc.createTicket(ada, a1.key, { title: "Bob's", assigneeId: bob.id });
    await pmem.removeTeamMember(ada, a1.key, eli.id);
    const db = await getDb();
    const [after] = await db.select().from(schema.tickets).where(eq(schema.tickets.id, mine.id));
    assert.equal(after.assigneeId, null);
    assert.equal(after.teamId, a1.id, "team_id is left alone");
    const [theirs] = await db.select().from(schema.tickets).where(eq(schema.tickets.id, other.id));
    assert.equal(theirs.assigneeId, bob.id);
  });

  test("leaving the workspace unassigns the person too", async () => {
    const fay = await person(wsA.id, "member", "fay");
    await pmem.addTeamMember(ada, a1.key, { userId: fay.id, role: "editor" });
    const t = await svc.createTicket(ada, a1.key, { title: "Fay's", assigneeId: fay.id });
    const db = await getDb();
    await db.delete(schema.memberships).where(and(eq(schema.memberships.userId, fay.id), eq(schema.memberships.workspaceId, wsA.id)));
    const [after] = await db.select().from(schema.tickets).where(eq(schema.tickets.id, t.id));
    assert.equal(after.assigneeId, null);
  });

  test("the assignee key is in the database as written (drizzle cannot say SET NULL on one column)", async () => {
    const db = await getDb();
    const r = await db.execute(sql`select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'tickets_assignee_member_fk'`);
    const def = String((r as unknown as { rows?: { def: string }[] }).rows?.[0]?.def ?? (r as unknown as { def: string }[])[0]?.def);
    assert.match(def, /FOREIGN KEY \(team_id, assignee_id\) REFERENCES team_members\(team_id, user_id\) ON DELETE SET NULL \(assignee_id\)/);
  });
});
