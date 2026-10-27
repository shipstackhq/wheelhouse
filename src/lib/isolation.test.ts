/**
 * Cross-team isolation (WH-50). Two unrelated teams share one database; team B must never read or change anything
 * team A owns. Seeds both teams with data in every table, then attacks with A's ids, names and keys as B's human
 * and B's agent. Runs against a throwaway in-memory PGlite (`pnpm test`), or a real Postgres with
 * TEST_DATABASE_URL=postgres://... and `--test-force-exit`; the guards at the bottom fail the build when a
 * tool, a server action or a database-touching file is added without an isolation entry.
 */
if (process.env.TEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
} else {
  process.env.PGLITE_DIR = "memory://";
  delete process.env.DATABASE_URL;
}
delete process.env.ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_AUTH_TOKEN;

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { eq, inArray } from "drizzle-orm";
import { getDb, schema } from "@/db";
import type { Actor } from "./access";
import { actorForKey, sha256, userForSessionToken } from "./access";
import * as svc from "./service";
import * as members from "./members";
import { runTool, tools } from "./tools";
import { askMap } from "./ask";
import { briefing, ticketContext } from "./briefing";
import * as metrics from "./metrics";
import { resolveDraft } from "./sync";

const RUN = crypto.randomBytes(3).toString("hex");
const MARK = /a-secret/i; // everything team A owns carries this

type Side = {
  teamId: string;
  owner: Actor;
  ownerEmail: string;
  agent: Actor;
  keyId: string;
  key: string;
  projectKey: string;
  projectId: string;
  ticketRef: string;
  ticketId: string;
};
let A: Side & { nodeName: string; nodeId: string; dataName: string; flowName: string; termName: string; sessionId: string; draftId: string; spareKeyId: string; ownerId: string };
let B: Side & { memberId: string };

async function seedSide(label: "A" | "B") {
  const db = await getDb();
  const tag = label === "A" ? "A-SECRET" : "B-OWN";
  const [team] = await db.insert(schema.teams).values({ name: `${tag} team ${RUN}` }).returning();
  const ownerEmail = `${tag.toLowerCase()}-owner-${RUN}@example.com`;
  const [owner] = await db.insert(schema.users).values({ email: ownerEmail, name: `${tag} owner`, passwordHash: "x" }).returning();
  await db.insert(schema.memberships).values({ userId: owner.id, teamId: team.id, role: "owner" });
  const key = `wh_${crypto.randomBytes(18).toString("base64url")}`;
  const [k] = await db
    .insert(schema.apiKeys)
    .values({ teamId: team.id, name: `${tag} key`, prefix: key.slice(0, 10), keyHash: sha256(key), createdBy: owner.id })
    .returning();
  const human: Actor = { kind: "human", id: owner.id, name: `${tag} owner`, teamId: team.id };
  const agent: Actor = { kind: "agent", id: k.id, name: `${tag} key`, teamId: team.id };
  const projectKey = label === "A" ? "AA" : "BB";
  const project = await svc.createProject(human, { name: `${tag} project`, key: projectKey });
  // Both teams also have a project with the same key, to prove keys are per team.
  await svc.createProject(human, { name: `${tag} shared-key project`, key: "SH" });
  const t = await svc.createTicket(human, projectKey, { title: `${tag} ticket`, body: `${tag} body`, priority: "high" });
  await svc.createTicket(human, "SH", { title: `${tag} shared ticket` });
  await svc.addComment(human, t.ref, `${tag} comment`);
  return { teamId: team.id, owner: human, ownerEmail, ownerId: owner.id, agent, keyId: k.id, key, projectKey, projectId: project.id, ticketRef: t.ref, ticketId: t.id, tag };
}

async function seedMap(s: Awaited<ReturnType<typeof seedSide>>) {
  const k = s.projectKey;
  const sys = await svc.upsertNode(s.owner, k, { name: `${s.tag} system`, layer: "system", kind: "service", summary: `${s.tag} summary`, anchors: ["src/a/**"] });
  const concept = await svc.upsertNode(s.owner, k, { name: `${s.tag} concept`, layer: "concept", kind: "concept", summary: `${s.tag} concept` });
  const data = await svc.upsertNode(s.owner, k, {
    name: `${s.tag} table`,
    layer: "data",
    kind: "table",
    columns: [{ name: "id", type: "uuid", pk: true }] as never,
  });
  await svc.upsertEdge(s.owner, k, { from: sys.id, to: concept.id, kind: "implements" });
  await svc.linkTicketNode(s.owner, s.ticketRef, sys.name);
  await svc.upsertFlow(s.owner, k, { name: `${s.tag} flow`, steps: [{ node: sys.name, title: `${s.tag} step` }] });
  await svc.upsertDecision(s.owner, k, { title: `${s.tag} decision`, nodes: [sys.name] });
  await svc.upsertTerm(s.owner, k, { term: `${s.tag} term`, definition: `${s.tag} definition`, node: sys.name });
  return { sys, concept, data };
}

const fingerprint = async (s: { teamId: string; projectId: string; keyId: string }) => {
  const db = await getDb();
  const ps = (await db.select({ id: schema.projects.id }).from(schema.projects).where(eq(schema.projects.teamId, s.teamId))).map((p) => p.id);
  const keys = (await db.select({ id: schema.apiKeys.id }).from(schema.apiKeys).where(eq(schema.apiKeys.teamId, s.teamId))).map((p) => p.id);
  const tix = ps.length ? (await db.select({ id: schema.tickets.id }).from(schema.tickets).where(inArray(schema.tickets.projectId, ps))).map((t) => t.id) : [];
  const ns = ps.length ? (await db.select({ id: schema.nodes.id }).from(schema.nodes).where(inArray(schema.nodes.projectId, ps))).map((t) => t.id) : [];
  const byProject = <T extends { projectId: unknown }>(tbl: T & { projectId: never }) => ps.length ? db.select().from(tbl as never).where(inArray(tbl.projectId as never, ps)) : [];
  const parts = {
    teams: await db.select().from(schema.teams).where(eq(schema.teams.id, s.teamId)),
    members: await db.select().from(schema.memberships).where(eq(schema.memberships.teamId, s.teamId)),
    keys: await db.select().from(schema.apiKeys).where(eq(schema.apiKeys.teamId, s.teamId)),
    projects: await db.select().from(schema.projects).where(eq(schema.projects.teamId, s.teamId)),
    columns: await byProject(schema.columns as never),
    tickets: await byProject(schema.tickets as never),
    comments: tix.length ? await db.select().from(schema.comments).where(inArray(schema.comments.ticketId, tix)) : [],
    nodes: await byProject(schema.nodes as never),
    edges: await byProject(schema.edges as never),
    flows: await byProject(schema.flows as never),
    decisions: await byProject(schema.decisions as never),
    terms: await byProject(schema.terms as never),
    ticketNodes: tix.length ? await db.select().from(schema.ticketNodes).where(inArray(schema.ticketNodes.ticketId, tix)) : [],
    sessions: await byProject(schema.workSessions as never),
    drafts: await byProject(schema.nodeDrafts as never),
    files: await byProject(schema.projectFiles as never),
    cursors: keys.length ? await db.select().from(schema.agentCursors).where(inArray(schema.agentCursors.apiKeyId, keys)) : [],
    events: await db.select().from(schema.events).where(eq(schema.events.teamId, s.teamId)),
    nodeIds: ns,
  };
  const sorted = Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, (v as unknown[]).map((r) => JSON.stringify(r)).sort()]));
  return crypto.createHash("sha256").update(JSON.stringify(sorted)).digest("hex");
};

const isZodMessage = (m: string) => m.startsWith("✖");
type Attack = Record<string, unknown>;

before(async () => {
  const a = await seedSide("A");
  const map = await seedMap(a);
  const db = await getDb();
  const sessionId = `a-secret-session-${RUN}`;
  await db.insert(schema.workSessions).values({ id: sessionId, projectId: a.projectId, apiKeyId: a.keyId, actorName: a.agent.name, lastSeq: 0 });
  const [draft] = await db
    .insert(schema.nodeDrafts)
    .values({ projectId: a.projectId, nodeId: map.sys.id, sessionId, authorName: a.agent.name, authorKind: "agent", patch: { summary: "A-SECRET draft" } })
    .returning();
  await db.insert(schema.projectFiles).values({ projectId: a.projectId, path: "src/a/secret.ts", hash: "a".repeat(40) });
  const [spare] = await db
    .insert(schema.apiKeys)
    .values({ teamId: a.teamId, name: "A-SECRET spare key", prefix: "wh_spare", keyHash: sha256(`spare-${RUN}`), createdBy: a.ownerId })
    .returning();
  await svc.createTicket(a.agent, a.projectKey, { title: "A-SECRET agent ticket" }); // an event written by A's agent
  A = { ...a, nodeName: map.sys.name, nodeId: map.sys.id, dataName: map.data.name, flowName: `A-SECRET flow`, termName: `A-SECRET term`, sessionId, draftId: draft.id, spareKeyId: spare.id };

  const b = await seedSide("B");
  await seedMap(b);
  const [member] = await db.insert(schema.users).values({ email: `b-member-${RUN}@example.com`, name: "B member", passwordHash: "x" }).returning();
  await db.insert(schema.memberships).values({ userId: member.id, teamId: b.teamId, role: "member" });
  B = { ...b, memberId: member.id };
});

/**
 * One entry per tool: the calls an attacker in team B makes with team A's identifiers. Typed as a full record so a
 * new tool without an entry does not compile; the registry test below also checks it at run time.
 */
type ToolName = keyof typeof tools;
const attacks = {
  list_projects: () => [{}],
  create_project: () => [{ name: "B project", key: "BX" }],
  get_board: () => [{ project: A.projectKey }, { project: A.projectId }],
  get_ticket: () => [{ ticket: A.ticketRef }, { ticket: A.ticketId }],
  create_ticket: () => [{ project: A.projectKey, title: "B writes into A" }, { project: A.projectId, title: "B writes into A", link_nodes: [A.nodeName] }],
  update_ticket: () => [{ ticket: A.ticketRef, title: "hijacked" }, { ticket: A.ticketId, body: "hijacked" }],
  move_ticket: () => [{ ticket: A.ticketRef, column: "Done" }],
  claim_ticket: () => [{ ticket: A.ticketRef }],
  comment: () => [{ ticket: A.ticketRef, body: "B comments on A" }],
  get_changes: () => [{ project: A.projectKey }, { project: A.projectId }],
  ack_changes: () => [{ project: A.projectKey, seq: 999999 }],
  resume_session: () => [{ project: A.projectKey, mode: "replay" as const }],
  get_activity: () => [{ project: A.projectKey }],
  get_graph: () => [{ project: A.projectKey }, { project: A.projectKey, layer: "data" as const }],
  get_node: () => [{ project: A.projectKey, node: A.nodeName }, { project: A.projectKey, node: A.nodeId }],
  upsert_node: () => [
    { project: A.projectKey, name: "B node" },
    { project: A.projectKey, name: A.nodeName, id: A.nodeId, summary: "hijacked" },
  ],
  delete_node: () => [{ project: A.projectKey, node: A.nodeName }, { project: A.projectKey, node: A.nodeId }],
  upsert_edge: () => [{ project: A.projectKey, from: A.nodeName, to: A.dataName }],
  unlink_nodes: () => [{ project: A.projectKey, from: A.nodeName, to: "A-SECRET concept" }],
  link_ticket_node: () => [{ ticket: A.ticketRef, node: A.nodeName }, { ticket: A.ticketRef, node: A.nodeName, unlink: true }],
  get_schema: () => [{ project: A.projectKey }],
  upsert_table: () => [{ project: A.projectKey, name: A.dataName, summary: "hijacked", columns: [{ name: "id", type: "uuid" }] }],
  get_briefing: () => [{ project: A.projectKey }],
  get_ticket_context: () => [{ ticket: A.ticketRef }],
  delete_ticket: () => [{ ticket: A.ticketRef }, { ticket: A.ticketId }],
  delete_project: () => [{ project: A.projectKey }, { project: A.projectId }],
  session_sync: () => [{ project: A.projectKey, session: "b-session", files: ["src/a/x.ts"] }],
  session_status: () => [{ project: A.projectKey, session: A.sessionId }],
  session_end: () => [{ project: A.projectKey, session: A.sessionId }],
  land_changes: () => [{ project: A.projectKey, files: { "src/a/secret.ts": "b".repeat(40) } }],
  list_drafts: () => [{ project: A.projectKey }],
  get_flows: () => [{ project: A.projectKey }, { project: A.projectKey, name: A.flowName }],
  upsert_flow: () => [{ project: A.projectKey, name: A.flowName, description: "hijacked" }],
  delete_flow: () => [{ project: A.projectKey, flow: A.flowName }],
  report_changes: () => [{ project: A.projectKey, files: ["src/a/secret.ts"] }],
  get_stale_nodes: () => [{ project: A.projectKey }],
  mark_fresh: () => [{ project: A.projectKey, node: A.nodeName }],
  list_decisions: () => [{ project: A.projectKey }],
  upsert_decision: () => [{ project: A.projectKey, number: 1, title: "hijacked" }, { project: A.projectKey, title: "B decision in A" }],
  list_terms: () => [{ project: A.projectKey }],
  upsert_term: () => [{ project: A.projectKey, term: A.termName, definition: "hijacked" }],
  delete_term: () => [{ project: A.projectKey, term: A.termName }],
} satisfies Record<ToolName, () => Attack[]>;

/** Tools whose call is legitimate for any team and never touches the target: their result must still hold no A data. */
const harmless = new Set<string>(["list_projects", "create_project"]);

describe("every tool, called by team B with team A's identifiers", () => {
  for (const asKind of ["human", "agent"] as const) {
    test(`as B's ${asKind}: refused, nothing read, nothing changed`, async () => {
      const actor = asKind === "human" ? B.owner : B.agent;
      const before = await fingerprint(A);
      for (const name of Object.keys(tools) as ToolName[]) {
        for (const args of attacks[name]()) {
          let result: unknown;
          let error: unknown;
          try {
            result = await runTool(actor, name, args);
          } catch (e) {
            error = e;
          }
          const label = `${name}(${JSON.stringify(args).slice(0, 80)}) as ${asKind}`;
          if (error) {
            assert.ok(error instanceof svc.ServiceError, `${label}: expected a clean refusal, got ${error}`);
            assert.ok(["not_found", "forbidden", "invalid", "conflict"].includes(error.code), `${label}: ${error.code}`);
            assert.ok(!isZodMessage(error.message), `${label}: refused only because the arguments were malformed: ${error.message}`);
            assert.ok(!MARK.test(error.message), `${label}: the refusal leaks team A data: ${error.message}`);
          } else {
            assert.ok(harmless.has(name), `${label}: succeeded against team A's identifiers`);
            const text = JSON.stringify(result);
            assert.ok(!MARK.test(text), `${label}: returned team A data`);
            for (const id of [A.projectId, A.ticketId, A.nodeId, A.ownerId, A.keyId]) assert.ok(!text.includes(id), `${label}: returned an id of team A`);
          }
        }
      }
      assert.equal(await fingerprint(A), before, "team A's data is exactly as it was");
    });
  }

  test("a tool added without an isolation case fails here", () => {
    assert.deepEqual(Object.keys(attacks).sort(), Object.keys(tools).sort());
  });
});

describe("the attacks are real: the same calls work for the owner", () => {
  test("team A's own agent and human can do what B was refused", async () => {
    assert.equal((await runTool(A.agent, "get_ticket", { ticket: A.ticketRef }) as { ticket: { title: string } }).ticket.title, "A-SECRET ticket");
    await runTool(A.owner, "get_node", { project: A.projectKey, node: A.nodeName });
    await runTool(A.agent, "get_board", { project: A.projectId });
    await runTool(A.agent, "session_status", { project: A.projectKey, session: A.sessionId }).catch((e) => assert.ok(e instanceof svc.ServiceError));
  });
});

describe("project keys are per team", () => {
  test("two teams with a project called SH each see their own tickets", async () => {
    const a = (await runTool(A.owner, "get_ticket", { ticket: "SH-1" })) as { ticket: { title: string } };
    const b = (await runTool(B.owner, "get_ticket", { ticket: "SH-1" })) as { ticket: { title: string } };
    assert.equal(a.ticket.title, "A-SECRET shared ticket");
    assert.equal(b.ticket.title, "B-OWN shared ticket");
  });

});

describe("what B can see is only B's", () => {
  test("B's own board, graph, activity, queue, briefing and ticket context hold nothing of A's", async () => {
    const calls: Promise<unknown>[] = [
      runTool(B.owner, "get_board", { project: B.projectKey }),
      runTool(B.owner, "get_graph", { project: B.projectKey }),
      runTool(B.owner, "get_activity", { project: B.projectKey }),
      runTool(B.owner, "list_projects", {}),
      runTool(B.agent, "get_changes", { project: B.projectKey }),
      briefing(B.agent, B.projectKey),
      ticketContext(B.agent, B.ticketRef),
      svc.listEvents(B.owner, B.projectKey),
      svc.queueStatus(B.owner, B.projectKey),
    ];
    for (const r of await Promise.all(calls)) {
      const text = JSON.stringify(r);
      assert.ok(text.length > 20, "a real answer, not an empty one");
      assert.ok(!MARK.test(text), "no team A data");
      for (const id of [A.projectId, A.ticketId, A.nodeId, A.ownerId, A.keyId, A.teamId]) assert.ok(!text.includes(id));
    }
  });

  test("the dashboard numbers for B never include A", async () => {
    const all = await Promise.all([
      metrics.summary(B.owner),
      metrics.projectProgress(B.owner),
      metrics.throughput(B.owner),
      metrics.activityByActor(B.owner),
      metrics.agentQueues(B.owner),
      metrics.needsAttention(B.owner),
      metrics.recentActivity(B.owner),
      metrics.syncHealth(B.owner),
    ]);
    for (const r of all) {
      const text = JSON.stringify(r);
      assert.ok(!MARK.test(text), "no team A data on B's dashboard");
      assert.ok(!text.includes(A.projectId) && !text.includes(A.keyId));
    }
    const progress = (await metrics.projectProgress(B.owner)) as { key: string }[];
    assert.ok(!progress.some((p) => p.key === "AA" && JSON.stringify(p).includes("A-SECRET")));
  });

  test("B's agent queue never receives team A's events", async () => {
    const changes = (await runTool(B.agent, "get_changes", { project: B.projectKey })) as { changes: unknown[] };
    assert.ok(!MARK.test(JSON.stringify(changes)));
    await assert.rejects(runTool(B.agent, "get_changes", { project: A.projectKey }), svc.ServiceError);
  });
});

describe("briefing, context and Ask", () => {
  test("briefing and ticket context refuse team A's project and ticket", async () => {
    await assert.rejects(briefing(B.agent, A.projectKey), (e: unknown) => e instanceof svc.ServiceError && e.code === "not_found");
    await assert.rejects(ticketContext(B.agent, A.ticketRef), (e: unknown) => e instanceof svc.ServiceError && e.code === "not_found");
    await assert.rejects(ticketContext(B.owner, A.ticketId), (e: unknown) => e instanceof svc.ServiceError && e.code === "not_found");
  });

  test("Ask refuses team A's project before it would call the model", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-test-not-used";
    try {
      await assert.rejects(askMap(B.owner, A.projectKey, "what is in here?"), (e: unknown) => e instanceof svc.ServiceError && e.code === "not_found");
      await assert.rejects(askMap(B.owner, A.projectId, "x", A.nodeId), (e: unknown) => e instanceof svc.ServiceError && e.code === "not_found");
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });
});

describe("human-only and queue actions that take ids", () => {
  test("B cannot reset A's agent queue, remove A's session or resolve A's draft", async () => {
    const before = await fingerprint(A);
    await assert.rejects(svc.markAllSeen(B.owner, { keyId: A.keyId }), (e: unknown) => e instanceof svc.ServiceError && e.code === "not_found");
    await assert.rejects(svc.markAllSeen(B.owner, { keyId: A.keyId, projectRef: A.projectKey }), svc.ServiceError);
    await assert.rejects(svc.markAllSeen(B.owner, { projectRef: A.projectKey }), svc.ServiceError);
    await assert.rejects(svc.removeSession(B.owner, A.projectKey, A.sessionId), svc.ServiceError);
    await assert.rejects(svc.removeSession(B.owner, B.projectKey, A.sessionId), (e: unknown) => e instanceof svc.ServiceError && e.code === "not_found");
    await assert.rejects(resolveDraft(B.owner, A.projectKey, A.draftId, "publish"), svc.ServiceError);
    await assert.rejects(resolveDraft(B.owner, B.projectKey, A.draftId, "discard"), (e: unknown) => e instanceof svc.ServiceError && e.code === "not_found");
    await assert.rejects(svc.deleteProject(B.owner, A.projectKey), svc.ServiceError);
    assert.equal(await fingerprint(A), before);
  });

  test("a reset of 'all keys' by B only touches B's keys", async () => {
    const before = await fingerprint(A);
    const r = await svc.markAllSeen(B.owner, {});
    assert.ok(r.ok);
    assert.equal(await fingerprint(A), before);
  });

  test("B's agent using A's session id is refused and A's session is unchanged", async () => {
    const before = await fingerprint(A);
    for (const tool of ["get_changes", "ack_changes", "get_activity", "session_sync", "session_end", "session_status"] as const) {
      const args: Record<string, unknown> =
        tool === "ack_changes" ? { project: B.projectKey, seq: 5 } : tool.startsWith("session_") ? { project: B.projectKey, session: A.sessionId } : { project: B.projectKey };
      await assert.rejects(runTool(B.agent, tool, { ...args, session: A.sessionId }), (e: unknown) => e instanceof svc.ServiceError, tool);
    }
    assert.equal(await fingerprint(A), before);
  });
});

describe("members, keys and assignees", () => {
  test("B's owner cannot change or remove A's members or revoke A's keys", async () => {
    const before = await fingerprint(A);
    assert.equal(await members.updateMember(B.teamId, B.owner.id, { userId: A.ownerId, role: "member", tags: ["pwned"] }), false);
    assert.equal(await members.removeMember(B.teamId, B.owner.id, A.ownerId), false);
    assert.equal(await members.revokeApiKey(B.teamId, A.keyId), false);
    assert.equal(await members.revokeApiKey(B.teamId, A.spareKeyId), false);
    assert.equal(await fingerprint(A), before);
    assert.ok(await actorForKey(A.key, "9.9.9.9"), "A's key still works");
  });

  test("the same calls work on B's own members and keys", async () => {
    assert.equal(await members.updateMember(B.teamId, B.owner.id, { userId: B.memberId, role: "member", tags: ["ok"] }), true);
    assert.equal(await members.removeMember(B.teamId, B.owner.id, B.owner.id), false, "you cannot remove yourself");
    assert.equal(await members.removeMember(B.teamId, B.owner.id, B.memberId), true);
    const db = await getDb();
    const [k] = await db.insert(schema.apiKeys).values({ teamId: B.teamId, name: "temp", prefix: "wh_temp", keyHash: sha256(`temp-${RUN}`), createdBy: B.owner.id }).returning();
    assert.equal(await members.revokeApiKey(B.teamId, k.id), true);
  });

  test("the only owner cannot be demoted", async () => {
    assert.equal(await members.updateMember(B.teamId, B.owner.id, { userId: B.owner.id, role: "member", tags: [] }), false);
  });

  test("a ticket cannot be assigned to someone outside the team (regression)", async () => {
    const before = await fingerprint(A);
    await assert.rejects(svc.updateTicket(B.owner, B.ticketRef, { assigneeId: A.ownerId }), (e: unknown) => e instanceof svc.ServiceError && e.code === "invalid");
    await assert.rejects(svc.createTicket(B.owner, B.projectKey, { title: "x", assigneeId: A.ownerId }), (e: unknown) => e instanceof svc.ServiceError && e.code === "invalid");
    await assert.rejects(svc.updateTicket(B.owner, B.ticketRef, { assigneeId: "not-a-uuid" }), svc.ServiceError);
    await assert.rejects(svc.updateTicket(B.owner, B.ticketRef, { assigneeId: crypto.randomUUID() }), svc.ServiceError);
    const own = await svc.updateTicket(B.owner, B.ticketRef, { assigneeId: B.owner.id });
    assert.equal(own.assigneeId, B.owner.id, "an own-team assignee still works");
    assert.equal((await svc.updateTicket(B.owner, B.ticketRef, { assigneeId: null })).assigneeId, null);
    assert.equal(await fingerprint(A), before);
  });
});

describe("sign-in and keys do not cross teams", () => {
  test("a session or key from one team never resolves to the other", async () => {
    const db = await getDb();
    const token = crypto.randomBytes(24).toString("base64url");
    await db.insert(schema.sessions).values({ id: sha256(token), userId: B.owner.id, expiresAt: new Date(Date.now() + 864e5) });
    const u = await userForSessionToken(token);
    assert.equal(u?.id, B.owner.id);
    assert.notEqual(u?.id, A.ownerId);
    assert.equal((await actorForKey(B.key, "8.8.8.8")).teamId, B.teamId);
    assert.equal((await actorForKey(A.key, "8.8.8.8")).teamId, A.teamId);
  });
});

describe("project keys are per team (continued)", () => {
  test("B creating a project with A's key gets its own project, and A's is untouched", async () => {
    const before = await fingerprint(A);
    const p = (await runTool(B.owner, "create_project", { name: "B's AA", key: "AA" })) as { id: string; teamId: string };
    assert.equal(p.teamId, B.teamId);
    assert.notEqual(p.id, A.projectId);
    const board = (await runTool(B.owner, "get_board", { project: "AA" })) as { project: { name: string } };
    assert.equal(board.project.name, "B's AA");
    assert.equal(await fingerprint(A), before);
  });
});

// ───────── guards: new entry points must be audited ─────────

/** Every exported server action, and why it cannot cross teams. A new action must be added here. */
const ACTION_AUDIT: Record<string, string> = {
  signup: "creates a new team for the first account only",
  login: "authenticates by email and password",
  logout: "destroys the caller's own session",
  createInviteAction: "invites.ts: issuer's team from the session; new-team invites admin only",
  revokeInviteAction: "invites.ts: scoped to the issuer's team (or admin for new-team invites)",
  lookupInviteAction: "token holder only; one generic answer",
  acceptInviteAction: "token holder only; email, team and role come from the invite",
  suspendTeamAction: "teams-admin.ts: instance admin only",
  restoreTeamAction: "teams-admin.ts: instance admin only",
  updateMember: "members.ts: every statement scoped by the caller's team id (tested)",
  removeMember: "members.ts: every statement scoped by the caller's team id (tested)",
  changePassword: "the caller's own user row",
  createApiKey: "inserts with the caller's team id",
  revokeApiKey: "members.ts: scoped by the caller's team id (tested)",
  createProjectAction: "service.createProject with the caller's team",
  latestSeq: "service.getProject (team scoped) then events of that project",
  moveTicketAction: "service.moveTicket (resolveTicket joins the team)",
  createTicketAction: "service.createTicket (getProject)",
  updateTicketAction: "service.updateTicket (resolveTicket; assignee checked)",
  deleteTicketAction: "service.deleteTicket (resolveTicket)",
  getTicketAction: "service.getTicket (resolveTicket)",
  commentAction: "service.addComment (resolveTicket)",
  linkNodeAction: "service.linkTicketNode (ticket and node in one team project)",
  getGraphAction: "service.getGraph (getProject)",
  upsertNodeAction: "service.upsertNode (getProject)",
  deleteNodeAction: "service.deleteNode (getProject)",
  saveLayout: "service.saveLayout (nodes filtered by the team's project)",
  saveLayoutAction: "service.saveLayout (nodes filtered by the team's project)",
  connectNodesAction: "service.upsertEdge (getProject)",
  deleteEdgeAction: "service.deleteEdge (edge filtered by the team's project)",
  markFreshAction: "service.markFresh (getProject)",
  upsertFlowAction: "service.upsertFlow (getProject)",
  deleteFlowAction: "service.deleteFlow (getProject)",
  upsertDecisionAction: "service.upsertDecision (getProject)",
  upsertTermAction: "service.upsertTerm (getProject)",
  deleteTermAction: "service.deleteTerm (getProject)",
  askAction: "ask.askMap (getGraph, getProject)",
  markAllSeenAction: "service.markAllSeen (keys filtered by the caller's team)",
  removeSessionAction: "service.removeSession (project and session filtered by team)",
  resolveDraftAction: "sync.resolveDraft (draft filtered by the team's project)",
  createIdeaAction: "service.createIdea with the caller's team",
  setIdeaStatusAction: "service.setIdeaStatus (ownIdea filters by team)",
  commentIdeaAction: "service.addIdeaComment (ownIdea filters by team)",
  promoteIdeaAction: "service.promoteIdea (ownIdea and getProject filter by team)",
};

/** Files that call getDb() directly, and how each one scopes its queries. A new file must be added here. */
const DB_FILE_AUDIT: Record<string, string> = {
  "src/app/(app)/agents/page.tsx": "api keys and projects filtered by the caller's team id",
  "src/app/(app)/p/[key]/page.tsx": "members filtered by the caller's team id; the project via service",
  "src/app/(app)/team/page.tsx": "members filtered by the caller's team id; invites via invites.ts",
  "src/app/actions.ts": "see ACTION_AUDIT",
  "src/app/api/health/route.ts": "select 1, no data",
  "src/db/index.ts": "the connection itself",
  "src/lib/access.ts": "session and key lookup, the suspension check",
  "src/lib/auth.ts": "signup, sessions, membership of the signed-in user",
  "src/lib/invites.ts": "tokens; scoped by issuer team, or by the invite's own team at acceptance",
  "src/lib/members.ts": "every statement scoped by the caller's team id (tested)",
  "src/lib/metrics.ts": "everything derived from the caller's team's project ids",
  "src/lib/service.ts": "every function resolves through getProject / resolveTicket (tested)",
  "src/lib/sync.ts": "every entry point resolves through getProject first (tested)",
  "src/lib/teams-admin.ts": "instance admin only; metadata only (tested)",
};

const walk = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]));

describe("new entry points must be audited", () => {
  test("every exported server action has an audit entry", () => {
    const src = fs.readFileSync("src/app/actions.ts", "utf8");
    const exported = [...src.matchAll(/^export async function (\w+)/gm)].map((m) => m[1]).sort();
    const known = Object.keys(ACTION_AUDIT).filter((k) => exported.includes(k) || !["saveLayout"].includes(k)).sort();
    const missing = exported.filter((e) => !(e in ACTION_AUDIT));
    assert.deepEqual(missing, [], `server actions without an isolation audit entry: ${missing.join(", ")}`);
    assert.ok(known.length > 0);
  });

  test("every file that touches the database directly has an audit entry", () => {
    const files = walk("src")
      .filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f))
      .filter((f) => /\bgetDb\(/.test(fs.readFileSync(f, "utf8")))
      .map((f) => f.split(path.sep).join("/"))
      .sort();
    const missing = files.filter((f) => !(f in DB_FILE_AUDIT));
    assert.deepEqual(missing, [], `files that query the database without an isolation audit entry: ${missing.join(", ")}`);
    const stale = Object.keys(DB_FILE_AUDIT).filter((f) => !files.includes(f));
    assert.deepEqual(stale, [], `audit entries for files that no longer query the database: ${stale.join(", ")}`);
  });
});
