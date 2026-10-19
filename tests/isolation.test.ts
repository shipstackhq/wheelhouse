/**
 * Cross-workspace isolation (WH-50). Two unrelated workspaces share one database; workspace B must never read or change anything
 * workspace A owns. Seeds both workspaces with data in every table, then attacks with A's ids, names and keys as B's human
 * and B's agent. Runs against a throwaway in-memory PGlite (`pnpm test`), or a real Postgres with
 * TEST_DATABASE_URL=postgres://... and `--test-force-exit`; the guards at the bottom fail the build when a
 * tool or a database-touching file is added without an isolation entry.
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
import { getDb, schema } from "@wheelhouse/core/db";
import type { Actor } from "@wheelhouse/core/lib/access";
import { actorForKey, sha256, userForSessionToken } from "@wheelhouse/core/lib/access";
import * as svc from "@wheelhouse/core/lib/service";
import * as members from "@wheelhouse/core/lib/members";
import { runTool, tools } from "@wheelhouse/core/lib/tools";
import { askMap } from "@wheelhouse/core/lib/ask";
import { briefing, ticketContext } from "@wheelhouse/core/lib/briefing";
import * as metrics from "@wheelhouse/core/lib/metrics";
import { resolveDraft } from "@wheelhouse/core/lib/sync";
import * as sync from "@wheelhouse/core/lib/sync";

const RUN = crypto.randomBytes(3).toString("hex");
const MARK = /a-secret/i; // everything workspace A owns carries this

type Side = {
  workspaceId: string;
  owner: Actor;
  ownerEmail: string;
  agent: Actor;
  keyId: string;
  key: string;
  teamKey: string;
  teamId: string;
  ticketRef: string;
  ticketId: string;
};
let A: Side & {
  nodeName: string;
  nodeId: string;
  dataName: string;
  flowName: string;
  termName: string;
  sessionId: string;
  draftId: string;
  spareKeyId: string;
  ownerId: string;
  repoId: string;
  repoSlug: string;
  docId: string;
  docSlug: string;
};
let B: Side & { memberId: string };

async function seedSide(label: "A" | "B") {
  const db = await getDb();
  const tag = label === "A" ? "A-SECRET" : "B-OWN";
  const [workspace] = await db.insert(schema.workspaces).values({ name: `${tag} workspace ${RUN}` }).returning();
  const ownerEmail = `${tag.toLowerCase()}-owner-${RUN}@example.com`;
  const [owner] = await db.insert(schema.users).values({ email: ownerEmail, name: `${tag} owner`, passwordHash: "x" }).returning();
  await db.insert(schema.memberships).values({ userId: owner.id, workspaceId: workspace.id, role: "owner" });
  const key = `wh_${crypto.randomBytes(18).toString("base64url")}`;
  const [k] = await db
    .insert(schema.apiKeys)
    .values({ workspaceId: workspace.id, name: `${tag} key`, prefix: key.slice(0, 10), keyHash: sha256(key), createdBy: owner.id })
    .returning();
  const human: Actor = { kind: "human", id: owner.id, name: `${tag} owner`, workspaceId: workspace.id };
  const agent: Actor = { kind: "agent", id: k.id, name: `${tag} key`, workspaceId: workspace.id };
  const teamKey = label === "A" ? "AA" : "BB";
  const team = await svc.createTeam(human, { name: `${tag} team`, key: teamKey });
  // Both workspaces also have a team with the same key, to prove keys are per workspace.
  await svc.createTeam(human, { name: `${tag} shared-key team`, key: "SH" });
  const t = await svc.createTicket(human, teamKey, { title: `${tag} ticket`, body: `${tag} body`, priority: "high" });
  await svc.createTicket(human, "SH", { title: `${tag} shared ticket` });
  await svc.addComment(human, t.ref, `${tag} comment`);
  return { workspaceId: workspace.id, owner: human, ownerEmail, ownerId: owner.id, agent, keyId: k.id, key, teamKey, teamId: team.id, ticketRef: t.ref, ticketId: t.id, tag };
}

async function seedMap(s: Awaited<ReturnType<typeof seedSide>>) {
  const k = s.teamKey;
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
  const doc = await svc.createDoc(s.owner, k, { title: `${s.tag} doc`, body: `${s.tag} body with a secret word` });
  await svc.linkDocNode(s.owner, k, doc.id, sys.name);
  return { sys, concept, data, doc };
}

const fingerprint = async (s: { workspaceId: string; teamId: string; keyId: string }) => {
  const db = await getDb();
  const ps = (await db.select({ id: schema.teams.id }).from(schema.teams).where(eq(schema.teams.workspaceId, s.workspaceId))).map((p) => p.id);
  const keys = (await db.select({ id: schema.apiKeys.id }).from(schema.apiKeys).where(eq(schema.apiKeys.workspaceId, s.workspaceId))).map((p) => p.id);
  const tix = ps.length ? (await db.select({ id: schema.tickets.id }).from(schema.tickets).where(inArray(schema.tickets.teamId, ps))).map((t) => t.id) : [];
  const ns = ps.length ? (await db.select({ id: schema.nodes.id }).from(schema.nodes).where(inArray(schema.nodes.teamId, ps))).map((t) => t.id) : [];
  const byTeam = <T extends { teamId: unknown }>(tbl: T & { teamId: never }) => ps.length ? db.select().from(tbl as never).where(inArray(tbl.teamId as never, ps)) : [];
  const parts = {
    workspaces: await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, s.workspaceId)),
    members: await db.select().from(schema.memberships).where(eq(schema.memberships.workspaceId, s.workspaceId)),
    keys: await db.select().from(schema.apiKeys).where(eq(schema.apiKeys.workspaceId, s.workspaceId)),
    teams: await db.select().from(schema.teams).where(eq(schema.teams.workspaceId, s.workspaceId)),
    columns: await byTeam(schema.columns as never),
    tickets: await byTeam(schema.tickets as never),
    comments: tix.length ? await db.select().from(schema.comments).where(inArray(schema.comments.ticketId, tix)) : [],
    nodes: await byTeam(schema.nodes as never),
    edges: await byTeam(schema.edges as never),
    flows: await byTeam(schema.flows as never),
    decisions: await byTeam(schema.decisions as never),
    terms: await byTeam(schema.terms as never),
    docs: await byTeam(schema.docs as never),
    ticketNodes: tix.length ? await db.select().from(schema.ticketNodes).where(inArray(schema.ticketNodes.ticketId, tix)) : [],
    sessions: await byTeam(schema.workSessions as never),
    drafts: await byTeam(schema.nodeDrafts as never),
    docDrafts: await byTeam(schema.docDrafts as never),
    files: await byTeam(schema.teamFiles as never),
    repositories: await byTeam(schema.repositories as never),
    cursors: keys.length ? await db.select().from(schema.agentCursors).where(inArray(schema.agentCursors.apiKeyId, keys)) : [],
    events: await db.select().from(schema.events).where(eq(schema.events.workspaceId, s.workspaceId)),
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
  await db.insert(schema.workSessions).values({ id: sessionId, teamId: a.teamId, workspaceId: a.workspaceId, apiKeyId: a.keyId, actorName: a.agent.name, lastSeq: 0 });
  const [draft] = await db
    .insert(schema.nodeDrafts)
    .values({ teamId: a.teamId, workspaceId: a.workspaceId, nodeId: map.sys.id, sessionId, authorName: a.agent.name, authorKind: "agent", patch: { summary: "A-SECRET draft" } })
    .returning();
  await db.insert(schema.teamFiles).values({ teamId: a.teamId, workspaceId: a.workspaceId, path: "src/a/secret.ts", hash: "a".repeat(40) });
  const repo = await svc.createRepository(a.owner, a.teamKey, { displayName: "A-SECRET backend", role: "backend", slug: `a-secret-repo-${RUN}` });
  const [spare] = await db
    .insert(schema.apiKeys)
    .values({ workspaceId: a.workspaceId, name: "A-SECRET spare key", prefix: "wh_spare", keyHash: sha256(`spare-${RUN}`), createdBy: a.ownerId })
    .returning();
  await svc.createTicket(a.agent, a.teamKey, { title: "A-SECRET agent ticket" }); // an event written by A's agent
  A = {
    ...a,
    nodeName: map.sys.name,
    nodeId: map.sys.id,
    dataName: map.data.name,
    flowName: `A-SECRET flow`,
    termName: `A-SECRET term`,
    sessionId,
    draftId: draft.id,
    spareKeyId: spare.id,
    repoId: repo.id,
    repoSlug: repo.slug,
    docId: map.doc.id,
    docSlug: map.doc.slug,
  };

  const b = await seedSide("B");
  await seedMap(b);
  const [member] = await db.insert(schema.users).values({ email: `b-member-${RUN}@example.com`, name: "B member", passwordHash: "x" }).returning();
  await db.insert(schema.memberships).values({ userId: member.id, workspaceId: b.workspaceId, role: "member" });
  B = { ...b, memberId: member.id };
});

/**
 * One entry per tool: the calls an attacker in workspace B makes with workspace A's identifiers. Typed as a full record so a
 * new tool without an entry does not compile; the registry test below also checks it at run time.
 */
type ToolName = keyof typeof tools;
const attacks = {
  list_projects: () => [{}],
  create_project: () => [{ name: "B project", key: "BX" }],
  get_board: () => [{ project: A.teamKey }, { project: A.teamId }],
  get_ticket: () => [{ ticket: A.ticketRef }, { ticket: A.ticketId }],
  create_ticket: () => [{ project: A.teamKey, title: "B writes into A" }, { project: A.teamId, title: "B writes into A", link_nodes: [A.nodeName] }],
  update_ticket: () => [{ ticket: A.ticketRef, title: "hijacked" }, { ticket: A.ticketId, body: "hijacked" }],
  move_ticket: () => [{ ticket: A.ticketRef, column: "Done" }],
  claim_ticket: () => [{ ticket: A.ticketRef }],
  comment: () => [{ ticket: A.ticketRef, body: "B comments on A" }],
  get_changes: () => [{ project: A.teamKey }, { project: A.teamId }],
  ack_changes: () => [{ project: A.teamKey, seq: 999999 }],
  resume_session: () => [{ project: A.teamKey, mode: "replay" as const }],
  get_activity: () => [{ project: A.teamKey }],
  get_graph: () => [{ project: A.teamKey }, { project: A.teamKey, layer: "data" as const }],
  get_node: () => [{ project: A.teamKey, node: A.nodeName }, { project: A.teamKey, node: A.nodeId }],
  upsert_node: () => [
    { project: A.teamKey, name: "B node" },
    { project: A.teamKey, name: A.nodeName, id: A.nodeId, summary: "hijacked" },
  ],
  delete_node: () => [{ project: A.teamKey, node: A.nodeName }, { project: A.teamKey, node: A.nodeId }],
  upsert_edge: () => [{ project: A.teamKey, from: A.nodeName, to: A.dataName }],
  unlink_nodes: () => [{ project: A.teamKey, from: A.nodeName, to: "A-SECRET concept" }],
  link_ticket_node: () => [{ ticket: A.ticketRef, node: A.nodeName }, { ticket: A.ticketRef, node: A.nodeName, unlink: true }],
  get_schema: () => [{ project: A.teamKey }],
  upsert_table: () => [{ project: A.teamKey, name: A.dataName, summary: "hijacked", columns: [{ name: "id", type: "uuid" }] }],
  get_briefing: () => [{ project: A.teamKey }],
  get_ticket_context: () => [{ ticket: A.ticketRef }],
  delete_ticket: () => [{ ticket: A.ticketRef }, { ticket: A.ticketId }],
  delete_project: () => [{ project: A.teamKey }, { project: A.teamId }],
  session_sync: () => [{ project: A.teamKey, session: "b-session", files: ["src/a/x.ts"] }],
  session_status: () => [{ project: A.teamKey, session: A.sessionId }],
  session_end: () => [{ project: A.teamKey, session: A.sessionId }],
  land_changes: () => [{ project: A.teamKey, files: { "src/a/secret.ts": "b".repeat(40) } }],
  list_drafts: () => [{ project: A.teamKey }],
  get_flows: () => [{ project: A.teamKey }, { project: A.teamKey, name: A.flowName }],
  upsert_flow: () => [{ project: A.teamKey, name: A.flowName, description: "hijacked" }],
  delete_flow: () => [{ project: A.teamKey, flow: A.flowName }],
  report_changes: () => [{ project: A.teamKey, files: ["src/a/secret.ts"] }],
  get_stale_nodes: () => [{ project: A.teamKey }],
  mark_fresh: () => [{ project: A.teamKey, node: A.nodeName }],
  list_decisions: () => [{ project: A.teamKey }],
  upsert_decision: () => [{ project: A.teamKey, number: 1, title: "hijacked" }, { project: A.teamKey, title: "B decision in A" }],
  list_terms: () => [{ project: A.teamKey }],
  upsert_term: () => [{ project: A.teamKey, term: A.termName, definition: "hijacked" }],
  delete_term: () => [{ project: A.teamKey, term: A.termName }],
  list_repositories: () => [{ project: A.teamKey }, { project: A.teamId }],
  list_docs: () => [{ project: A.teamKey }, { project: A.teamId }, { project: A.teamKey, parent: A.docSlug }],
  get_doc: () => [{ project: A.teamKey, doc: A.docSlug }, { project: A.teamKey, doc: A.docId }],
  search_docs: () => [{ project: A.teamKey, query: "secret" }, { project: A.teamId, query: "secret" }],
  upsert_doc: () => [
    { project: A.teamKey, title: "B doc in A" },
    { project: A.teamKey, doc: A.docSlug, title: "hijacked" },
    { project: A.teamKey, doc: A.docId, body: "hijacked" },
  ],
  delete_doc: () => [{ project: A.teamKey, doc: A.docSlug }, { project: A.teamKey, doc: A.docId }],
  link_doc_node: () => [{ project: A.teamKey, doc: A.docSlug, node: A.nodeName }, { project: A.teamKey, doc: A.docId, node: A.nodeName, unlink: true }],
  suggest_doc_anchors: () => [{ project: A.teamKey, doc: A.docSlug }, { project: A.teamKey, doc: A.docId }],
  get_stale_docs: () => [{ project: A.teamKey }],
  mark_doc_fresh: () => [{ project: A.teamKey, doc: A.docSlug }, { project: A.teamKey, doc: A.docId }],
  list_doc_drafts: () => [{ project: A.teamKey }],
  list_doc_templates: () => [], // static global metadata, no workspace data to attack (WH-65)
} satisfies Record<ToolName, () => Attack[]>;

/** Tools whose call is legitimate for any workspace and never touches the target: their result must still hold no A data. */
const harmless = new Set<string>(["list_projects", "create_project"]);

describe("every tool, called by workspace B with workspace A's identifiers", () => {
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
            assert.ok(!MARK.test(error.message), `${label}: the refusal leaks workspace A data: ${error.message}`);
          } else {
            assert.ok(harmless.has(name), `${label}: succeeded against workspace A's identifiers`);
            const text = JSON.stringify(result);
            assert.ok(!MARK.test(text), `${label}: returned workspace A data`);
            for (const id of [A.teamId, A.ticketId, A.nodeId, A.ownerId, A.keyId]) assert.ok(!text.includes(id), `${label}: returned an id of workspace A`);
          }
        }
      }
      assert.equal(await fingerprint(A), before, "workspace A's data is exactly as it was");
    });
  }

  test("a tool added without an isolation case fails here", () => {
    assert.deepEqual(Object.keys(attacks).sort(), Object.keys(tools).sort());
  });
});

describe("the attacks are real: the same calls work for the owner", () => {
  test("workspace A's own agent and human can do what B was refused", async () => {
    assert.equal((await runTool(A.agent, "get_ticket", { ticket: A.ticketRef }) as { ticket: { title: string } }).ticket.title, "A-SECRET ticket");
    await runTool(A.owner, "get_node", { project: A.teamKey, node: A.nodeName });
    await runTool(A.agent, "get_board", { project: A.teamId });
    await runTool(A.agent, "session_status", { project: A.teamKey, session: A.sessionId }).catch((e) => assert.ok(e instanceof svc.ServiceError));
  });
});

describe("team keys are per workspace", () => {
  test("two workspaces with a team called SH each see their own tickets", async () => {
    const a = (await runTool(A.owner, "get_ticket", { ticket: "SH-1" })) as { ticket: { title: string } };
    const b = (await runTool(B.owner, "get_ticket", { ticket: "SH-1" })) as { ticket: { title: string } };
    assert.equal(a.ticket.title, "A-SECRET shared ticket");
    assert.equal(b.ticket.title, "B-OWN shared ticket");
  });

});

describe("what B can see is only B's", () => {
  test("B's own board, graph, activity, queue, briefing and ticket context hold nothing of A's", async () => {
    const calls: Promise<unknown>[] = [
      runTool(B.owner, "get_board", { project: B.teamKey }),
      runTool(B.owner, "get_graph", { project: B.teamKey }),
      runTool(B.owner, "get_activity", { project: B.teamKey }),
      runTool(B.owner, "list_projects", {}),
      runTool(B.agent, "get_changes", { project: B.teamKey }),
      briefing(B.agent, B.teamKey),
      ticketContext(B.agent, B.ticketRef),
      svc.listEvents(B.owner, B.teamKey),
      svc.queueStatus(B.owner, B.teamKey),
    ];
    for (const r of await Promise.all(calls)) {
      const text = JSON.stringify(r);
      assert.ok(text.length > 20, "a real answer, not an empty one");
      assert.ok(!MARK.test(text), "no workspace A data");
      for (const id of [A.teamId, A.ticketId, A.nodeId, A.ownerId, A.keyId, A.workspaceId]) assert.ok(!text.includes(id));
    }
  });

  test("the dashboard numbers for B never include A", async () => {
    const all = await Promise.all([
      metrics.summary(B.owner),
      metrics.teamProgress(B.owner),
      metrics.throughput(B.owner),
      metrics.activityByActor(B.owner),
      metrics.agentQueues(B.owner),
      metrics.needsAttention(B.owner),
      metrics.recentActivity(B.owner),
      metrics.syncHealth(B.owner),
    ]);
    for (const r of all) {
      const text = JSON.stringify(r);
      assert.ok(!MARK.test(text), "no workspace A data on B's dashboard");
      assert.ok(!text.includes(A.teamId) && !text.includes(A.keyId));
    }
    const progress = (await metrics.teamProgress(B.owner)) as { key: string }[];
    assert.ok(!progress.some((p) => p.key === "AA" && JSON.stringify(p).includes("A-SECRET")));
  });

  test("B's agent queue never receives workspace A's events", async () => {
    const changes = (await runTool(B.agent, "get_changes", { project: B.teamKey })) as { changes: unknown[] };
    assert.ok(!MARK.test(JSON.stringify(changes)));
    await assert.rejects(runTool(B.agent, "get_changes", { project: A.teamKey }), svc.ServiceError);
  });
});

describe("briefing, context and Ask", () => {
  test("briefing and ticket context refuse workspace A's team and ticket", async () => {
    await assert.rejects(briefing(B.agent, A.teamKey), (e: unknown) => e instanceof svc.ServiceError && e.code === "not_found");
    await assert.rejects(ticketContext(B.agent, A.ticketRef), (e: unknown) => e instanceof svc.ServiceError && e.code === "not_found");
    await assert.rejects(ticketContext(B.owner, A.ticketId), (e: unknown) => e instanceof svc.ServiceError && e.code === "not_found");
  });

  test("Ask refuses workspace A's team before it would call the model", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-test-not-used";
    try {
      await assert.rejects(askMap(B.owner, A.teamKey, "what is in here?"), (e: unknown) => e instanceof svc.ServiceError && e.code === "not_found");
      await assert.rejects(askMap(B.owner, A.teamId, "x", A.nodeId), (e: unknown) => e instanceof svc.ServiceError && e.code === "not_found");
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });
});

describe("human-only and queue actions that take ids", () => {
  test("B cannot reset A's agent queue, remove A's session or resolve A's draft", async () => {
    const before = await fingerprint(A);
    await assert.rejects(svc.markAllSeen(B.owner, { keyId: A.keyId }), (e: unknown) => e instanceof svc.ServiceError && e.code === "not_found");
    await assert.rejects(svc.markAllSeen(B.owner, { keyId: A.keyId, teamRef: A.teamKey }), svc.ServiceError);
    await assert.rejects(svc.markAllSeen(B.owner, { teamRef: A.teamKey }), svc.ServiceError);
    await assert.rejects(svc.removeSession(B.owner, A.teamKey, A.sessionId), svc.ServiceError);
    await assert.rejects(svc.removeSession(B.owner, B.teamKey, A.sessionId), (e: unknown) => e instanceof svc.ServiceError && e.code === "not_found");
    await assert.rejects(resolveDraft(B.owner, A.teamKey, A.draftId, "publish"), svc.ServiceError);
    await assert.rejects(resolveDraft(B.owner, B.teamKey, A.draftId, "discard"), (e: unknown) => e instanceof svc.ServiceError && e.code === "not_found");
    await assert.rejects(svc.deleteTeam(B.owner, A.teamKey), svc.ServiceError);
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
        tool === "ack_changes" ? { project: B.teamKey, seq: 5 } : tool.startsWith("session_") ? { project: B.teamKey, session: A.sessionId } : { project: B.teamKey };
      await assert.rejects(runTool(B.agent, tool, { ...args, session: A.sessionId }), (e: unknown) => e instanceof svc.ServiceError, tool);
    }
    assert.equal(await fingerprint(A), before);
  });
});

describe("members, keys and assignees", () => {
  test("B's owner cannot change or remove A's members or revoke A's keys", async () => {
    const before = await fingerprint(A);
    assert.equal(await members.updateMember(B.workspaceId, B.owner.id, { userId: A.ownerId, role: "member", tags: ["pwned"] }), false);
    assert.equal(await members.removeMember(B.workspaceId, B.owner.id, A.ownerId), false);
    assert.equal(await members.revokeApiKey(B.workspaceId, A.keyId), false);
    assert.equal(await members.revokeApiKey(B.workspaceId, A.spareKeyId), false);
    assert.equal(await fingerprint(A), before);
    assert.ok(await actorForKey(A.key, "9.9.9.9"), "A's key still works");
  });

  test("the same calls work on B's own members and keys", async () => {
    assert.equal(await members.updateMember(B.workspaceId, B.owner.id, { userId: B.memberId, role: "member", tags: ["ok"] }), true);
    assert.equal(await members.removeMember(B.workspaceId, B.owner.id, B.owner.id), false, "you cannot remove yourself");
    assert.equal(await members.removeMember(B.workspaceId, B.owner.id, B.memberId), true);
    const db = await getDb();
    const [k] = await db.insert(schema.apiKeys).values({ workspaceId: B.workspaceId, name: "temp", prefix: "wh_temp", keyHash: sha256(`temp-${RUN}`), createdBy: B.owner.id }).returning();
    assert.equal(await members.revokeApiKey(B.workspaceId, k.id), true);
  });

  test("the only owner cannot be demoted", async () => {
    assert.equal(await members.updateMember(B.workspaceId, B.owner.id, { userId: B.owner.id, role: "member", tags: [] }), false);
  });

  test("a ticket cannot be assigned to someone outside the workspace (regression)", async () => {
    const before = await fingerprint(A);
    await assert.rejects(svc.updateTicket(B.owner, B.ticketRef, { assigneeId: A.ownerId }), (e: unknown) => e instanceof svc.ServiceError && e.code === "invalid");
    await assert.rejects(svc.createTicket(B.owner, B.teamKey, { title: "x", assigneeId: A.ownerId }), (e: unknown) => e instanceof svc.ServiceError && e.code === "invalid");
    await assert.rejects(svc.updateTicket(B.owner, B.ticketRef, { assigneeId: "not-a-uuid" }), svc.ServiceError);
    await assert.rejects(svc.updateTicket(B.owner, B.ticketRef, { assigneeId: crypto.randomUUID() }), svc.ServiceError);
    const own = await svc.updateTicket(B.owner, B.ticketRef, { assigneeId: B.owner.id });
    assert.equal(own.assigneeId, B.owner.id, "an own-workspace assignee still works");
    assert.equal((await svc.updateTicket(B.owner, B.ticketRef, { assigneeId: null })).assigneeId, null);
    assert.equal(await fingerprint(A), before);
  });
});

describe("repositories (WH-68)", () => {
  test("B cannot read, edit or retire A's repositories through the service layer", async () => {
    const before = await fingerprint(A);
    await assert.rejects(svc.listRepositories(B.owner, A.teamKey), (e: unknown) => e instanceof svc.ServiceError && e.code === "not_found");
    await assert.rejects(svc.updateRepository(B.owner, A.teamKey, A.repoId, { displayName: "hijacked" }), svc.ServiceError);
    await assert.rejects(svc.updateRepository(B.owner, B.teamKey, A.repoId, { displayName: "hijacked" }), (e: unknown) => e instanceof svc.ServiceError && e.code === "not_found");
    await assert.rejects(svc.retireRepository(B.owner, B.teamKey, A.repoId), (e: unknown) => e instanceof svc.ServiceError && e.code === "not_found");
    await assert.rejects(svc.createRepository(B.agent, B.teamKey, { displayName: "x", role: "backend" }), (e: unknown) => e instanceof svc.ServiceError && e.code === "forbidden");
    const list = await svc.listRepositories(B.owner, B.teamKey);
    assert.ok(!JSON.stringify(list).includes(A.repoId));
    assert.equal(await fingerprint(A), before);
  });

  test("B cannot browse A's connected repo's tree by guessing A's repositoryId (WH-82)", async () => {
    // The web API's repository browse resolves the repository the same way: svc.listRepositories(actor, teamKey)
    // then matches repositoryId against that list. A's repo never appears in B's list, so B's lookup fails
    // closed (not_found) before any GitHub API call would be made — mirrored here at the service layer.
    const bList = await svc.listRepositories(B.owner, B.teamKey);
    assert.ok(!bList.some((r) => r.id === A.repoId), "A's repository must not be visible when listing B's team");
    // Even if B passes A's team key, B isn't a member of A's workspace so requireTeam itself rejects first.
    await assert.rejects(svc.listRepositories(B.owner, A.teamKey), (e: unknown) => e instanceof svc.ServiceError && e.code === "not_found");
  });

  test("B's own repository CRUD works end to end and is scoped to B's team", async () => {
    const r = await svc.createRepository(B.owner, B.teamKey, { displayName: "B frontend", role: "frontend", pathLimit: "apps/web/" });
    assert.equal(r.lifecycle, "live");
    const updated = await svc.updateRepository(B.owner, B.teamKey, r.id, { lifecycle: "being_replaced" });
    assert.equal(updated.lifecycle, "being_replaced");
    const retired = await svc.retireRepository(B.owner, B.teamKey, r.id);
    assert.equal(retired.lifecycle, "retired");
    const list = await svc.listRepositories(B.owner, B.teamKey);
    assert.ok(list.some((x) => x.id === r.id));
  });

  test("find-or-create is per team: the same slug in two teams is two rows, each with its own path limit", async () => {
    const mono = `mono-${RUN}`;
    const r1 = await svc.findOrCreateRepository(A.owner, A.teamId, mono);
    const r2 = await svc.findOrCreateRepository(B.owner, B.teamId, mono);
    assert.notEqual(r1.id, r2.id);
    assert.equal(r1.slug, r2.slug);
    await svc.updateRepository(A.owner, A.teamKey, r1.id, { pathLimit: "packages/billing/" });
    await svc.updateRepository(B.owner, B.teamKey, r2.id, { pathLimit: "packages/auth/" });

    // A landed change under packages/auth/ should only register for the team whose path limit matches it.
    const before1 = (await svc.listRepositories(A.owner, A.teamKey)).find((x) => x.id === r1.id)!.lastEventAt;
    const landed = await sync.land(A.owner, A.teamKey, { files: { "packages/auth/index.ts": "f".repeat(40) }, repository: mono });
    assert.equal(landed.files, 0, "outside A's path limit: nothing lands for A's team");
    const after1 = (await svc.listRepositories(A.owner, A.teamKey)).find((x) => x.id === r1.id)!.lastEventAt;
    assert.equal(before1?.getTime(), after1?.getTime());

    const landedForB = await sync.land(B.owner, B.teamKey, { files: { "packages/auth/index.ts": "f".repeat(40) }, repository: mono });
    assert.equal(landedForB.files, 1, "inside B's path limit: it lands for B's team");
  });
});

describe("doc staleness (WH-64) never crosses workspaces", () => {
  test("report_changes / land for A's anchored path never flags or touches B's doc", async () => {
    const aDoc = await svc.createDoc(A.owner, A.teamKey, { title: "A anchored doc", body: "watches src/shared/x.ts", anchors: ["src/shared/x.ts"] });
    const bDoc = await svc.createDoc(B.owner, B.teamKey, { title: "B anchored doc", body: "watches src/shared/x.ts", anchors: ["src/shared/x.ts"] });
    await svc.reportChanges(A.owner, A.teamKey, { files: ["src/shared/x.ts"], sha: "a".repeat(40) });
    const { doc: aAfter } = await svc.getDoc(A.owner, A.teamKey, aDoc.id);
    const { doc: bAfter } = await svc.getDoc(B.owner, B.teamKey, bDoc.id);
    assert.equal(aAfter.stale, true, "A's own doc is flagged");
    assert.equal(bAfter.stale, false, "B's doc with the identical anchor is untouched by A's report");

    await sync.land(B.owner, B.teamKey, { files: { "src/shared/x.ts": "f".repeat(40) } });
    const { doc: aAfter2 } = await svc.getDoc(A.owner, A.teamKey, aDoc.id);
    assert.equal(aAfter2.stale, true, "B landing the same path never clears or otherwise changes A's doc");
  });

  test("B cannot mark A's doc fresh, resolve A's doc draft, or read A's stale docs", async () => {
    const aDoc = await svc.createDoc(A.owner, A.teamKey, { title: "A fresh-check doc", anchors: ["src/shared/y.ts"] });
    await svc.reportChanges(A.owner, A.teamKey, { files: ["src/shared/y.ts"] });
    const before = await fingerprint(A);
    await assert.rejects(svc.markDocFresh(B.owner, A.teamKey, aDoc.id), (e: unknown) => e instanceof svc.ServiceError && e.code === "not_found");
    await assert.rejects(sync.resolveDocDraft(B.owner, A.teamKey, crypto.randomUUID(), "publish"), svc.ServiceError);
    const bStale = await svc.listStaleDocs(B.owner, B.teamKey);
    assert.ok(!JSON.stringify(bStale).includes(aDoc.id));
    const { doc: stillStale } = await svc.getDoc(A.owner, A.teamKey, aDoc.id);
    assert.equal(stillStale.stale, true, "B's failed attempt did not clear A's flag");
    assert.equal(await fingerprint(A), before);
  });
});

describe("sign-in and keys do not cross workspaces", () => {
  test("a session or key from one workspace never resolves to the other", async () => {
    const db = await getDb();
    const token = crypto.randomBytes(24).toString("base64url");
    await db.insert(schema.sessions).values({ id: sha256(token), userId: B.owner.id, expiresAt: new Date(Date.now() + 864e5) });
    const u = await userForSessionToken(token);
    assert.equal(u?.id, B.owner.id);
    assert.notEqual(u?.id, A.ownerId);
    assert.equal((await actorForKey(B.key, "8.8.8.8")).workspaceId, B.workspaceId);
    assert.equal((await actorForKey(A.key, "8.8.8.8")).workspaceId, A.workspaceId);
  });
});

describe("team keys are per workspace (continued)", () => {
  test("B creating a team with A's key gets its own team, and A's is untouched", async () => {
    const before = await fingerprint(A);
    const p = (await runTool(B.owner, "create_project", { name: "B's AA", key: "AA" })) as { id: string; teamId: string }; // the tool wire: teamId is still the workspace
    assert.equal(p.teamId, B.workspaceId);
    assert.notEqual(p.id, A.teamId);
    const board = (await runTool(B.owner, "get_board", { project: "AA" })) as { project: { name: string } };
    assert.equal(board.project.name, "B's AA");
    assert.equal(await fingerprint(A), before);
  });
});

describe("the database refuses a row that points across workspaces (WH-113)", () => {
  // Even code that skips the service layer cannot put workspace B's row on workspace A's team, or the reverse.
  const refused = (e: unknown) => (e as { cause?: { code?: string } }).cause?.code === "23503";

  test("B's workspace id on A's team is refused, for a column, a node and a team member", async () => {
    const db = await getDb();
    const before = await fingerprint(A);
    await assert.rejects(db.insert(schema.columns).values({ teamId: A.teamId, workspaceId: B.workspaceId, name: "planted", position: 99 }), refused);
    await assert.rejects(db.insert(schema.nodes).values({ teamId: A.teamId, workspaceId: B.workspaceId, layer: "system", kind: "service", name: "planted" }), refused);
    await assert.rejects(db.insert(schema.teamMembers).values({ teamId: A.teamId, workspaceId: B.workspaceId, userId: B.owner.id, role: "admin" }), refused);
    assert.equal(await fingerprint(A), before);
  });

  test("B's owner cannot be made a member of A's team under A's workspace either: they are not in it", async () => {
    const db = await getDb();
    await assert.rejects(db.insert(schema.teamMembers).values({ teamId: A.teamId, workspaceId: A.workspaceId, userId: B.owner.id, role: "admin" }), refused);
  });

  test("a ticket of A cannot be assigned to someone from B, through the service or around it", async () => {
    const db = await getDb();
    await assert.rejects(svc.updateTicket(A.owner, A.ticketRef, { assigneeId: B.owner.id }), svc.ServiceError);
    await assert.rejects(db.update(schema.tickets).set({ assigneeId: B.owner.id }).where(eq(schema.tickets.id, A.ticketId)), refused);
  });
});

// ───────── guards: new entry points must be audited ─────────

/** Files that call getDb() directly, and how each one scopes its queries. A new file must be added here. */
const DB_FILE_AUDIT: Record<string, string> = {
  "apps/api/src/database/database.service.ts": "opens the connection and runs the migrations at startup, then closes it on shutdown; runs no queries. No controller or guard may appear in this list",
  "packages/core/src/db/index.ts": "the connection itself",
  "packages/core/src/lib/access.ts": "session and key lookup, the suspension check",
  "packages/core/src/lib/accounts.ts": "signup creates the new user and a workspace they own; login looks one account up by email and checks its password; neither reads another workspace's data (tested)",
  "packages/core/src/lib/auth-core.ts": "the signed-in user's membership, looked up by the id of the user a verified session or key already resolved to",
  "packages/core/src/lib/invites.ts": "tokens; scoped by issuer workspace, or by the invite's own workspace at acceptance",
  "packages/core/src/lib/members.ts": "every statement scoped by the caller's workspace id (tested); removing a member also clears their team rows in that workspace",
  "packages/core/src/lib/team-members.ts": "every query starts from requireTeam(actor, key, need), which answers not_found for a team the person is not a member of (ADR-23); the workspace-wide views (all team names, the audit log) are for workspace owners and admins and filter by the caller's workspace id (tested in team-access.test.ts and over HTTP)",
  "packages/core/src/lib/stream-scope.ts": "the team stream resolves the team through requireTeam(actor); the dashboard stream is filtered to the teams the person is a member of, in the replay and for live events (tested)",
  "packages/core/src/lib/metrics.ts": "everything derived from the caller's workspace's team ids",
  "packages/core/src/lib/github/service.ts": "webhooks reach a repository only through its workspace's own registered installation (targetsFor joins installation workspace = team workspace; tested with two workspaces sharing a GitHub repo id); connecting is owner-only and checks the installation belongs to the caller's workspace",
  "packages/core/src/lib/service.ts": "every function resolves through requireTeam / resolveTicket (tested)",
  "packages/core/src/lib/stream-open.ts": "live streams: human sessions only, scope from stream-scope.ts (requireTeam / the caller's own workspace id, tested in live-events.test.ts), capped per user",
  "packages/core/src/lib/sync.ts": "every entry point resolves through requireTeam first (tested)",
  "packages/core/src/lib/workspaces-admin.ts": "instance admin only; metadata only (tested)",
  "packages/core/src/lib/board-app.ts": "the board's reads: the team is resolved through requireTeam(actor) (the service layer, scoped by workspace), and the map nodes and members are selected by that team's id and the actor's workspace id (tested over HTTP with two workspaces)",
  "packages/core/src/lib/docs-app.ts": "the web app's docs, repositories, GitHub connect and onboarding functions: the only direct query reads the members of the signed-in person's own workspace; everything else goes through the service layer, which resolves the team with requireTeam(actor) and finds docs, nodes and repositories inside it (tested)",
  "packages/core/src/tools/post-migration-map.ts": "an operator's offline tool (docs/cutover.md), not a request handler: it is run by hand on the imported data. It looks up one team by key and the owner of that team's own workspace, and everything it changes goes through the service layer as that owner, so it can only reach that workspace's map (tested on a throwaway database)",
  "packages/core/src/lib/workspace-app.ts": "the web app's workspace, key and invite functions: every statement is scoped by the signed-in person's workspace id (members, keys, pending invites), a user or key id from another workspace matches nothing and reads as not found (tested)",
};

const walk = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]));

describe("new entry points must be audited", () => {
  test("every file that touches the database directly has an audit entry", () => {
    // The core package and the API: the service layer lives in packages/core and must stay covered.
    // The API too: its controllers and guards must not touch the database, so none has an audit entry and any that does fails here.
    const files = [...walk("packages/core/src"), ...walk("apps/api/src")]
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

/**
 * Every route the API serves, and what keeps it to the caller's own workspace (WH-93). The routes are read from the controllers, so a
 * new endpoint cannot be added without saying here how it is scoped. Controllers never touch the database (the audit above), so
 * "scoped" means: the person or key is resolved first, and everything after is the service layer, which takes the actor.
 */
const API_ROUTE_AUDIT: Record<string, string> = {
  "GET /api/health": "select 1; no data, no auth",
  "POST /mcp": "actor from the API key or session (ActorGuard); every tool runs through the service layer with that actor (tested over HTTP in the contract suite)",
  "GET /mcp": "405, nothing read",
  "DELETE /mcp": "405, nothing read",
  "GET /api/v1": "tool definitions only; no data",
  "POST /api/v1/:tool": "actor from the API key or session (ActorGuard); the service layer is workspace scoped (tested over HTTP)",
  "POST /api/webhooks/github": "signature over the raw body first; a delivery reaches a repository only through its own workspace's registered installation (targetsFor joins installation workspace = team workspace; tested with two workspaces sharing a repository id and a forged row)",
  "GET /api/github/install": "a signed-in owner (HumanGuard); the team is resolved through requireTeam(actor), so another workspace's team is a 404",
  "GET /api/github/callback": "a signed-in owner; the signed state must name this person and the cookie's nonce; GitHub must say this person administers the installation; an installation belongs to one workspace",
  "GET /api/stream": "a person's session only; the scope is the caller's own workspace id (workspaceScope), never from the request, and is limited to the teams the person is a member of",
  "GET /api/teams/:key/stream": "a person's session only; the team is resolved through requireTeam(actor), another workspace's is a 404",
  "GET /api/app/auth/options": "whether sign-up is open; no data about any workspace, no auth",
  "POST /api/app/auth/login": "one account by email and password; rate limited per address and per account; starts that person's own session",
  "POST /api/app/auth/signup": "creates a new user and a new workspace they own; reads nothing of any workspace",
  "POST /api/app/auth/logout": "deletes the session named by the caller's own cookie",
  "GET /api/app/me": "the signed-in person from their session (SessionGuard); nothing taken from the request",
  "GET /api/app/teams": "listTeams(actor) for the signed-in person's workspace (SessionGuard); a workspaceId in the query or a header is ignored (tested)",
  "POST /api/app/teams": "svc.createTeam(actor): the team is made in the actor's own workspace; the workspace is never taken from the request (tested)",
  "PATCH /api/app/teams/:key": "svc.updateTeam(actor): requireTeam(actor, key, admin), so another workspace's team and one the person is not in are 404, a non-admin member is 403, and agents are refused; only name and description change, never the key (tested in team-access.test.ts)",
  "DELETE /api/app/teams/:key/sessions/:sessionId": "svc.removeSession(actor): the team is resolved through requireTeam(actor) and the session must belong to it, so another workspace's is a 404 (tested)",
  "POST /api/app/me/password": "changes the signed-in person's own password, after checking the current one; nothing is taken from the request but the two passwords",
  "GET /api/app/workspace": "workspaceOverview(human): the memberships of the person's own workspace; pending invites only for its owners (tested)",
  "GET /api/app/me/workspaces": "the signed-in person's own memberships only (auth-core.listWorkspaces, by their user id)",
  "POST /api/app/me/workspace": "switchWorkspace requires the person's own membership of that workspace (another workspace's id is a 404) and changes only this session's row (tested)",
  "POST /api/app/invites/peek-existing": "a signed-in person; the invite must name their own email, so someone else's invite is the usual invalid-link answer; rate limited per person",
  "POST /api/app/invites/accept-existing": "a signed-in person; the invite must name their own email and the workspace not be suspended; creates only their own membership and changes only this session's workspace (tested)",
  "GET /api/app/teams/:key/members": "requireTeam(actor, key): a team the person is not a member of, or of another workspace, is a 404 (tested over HTTP)",
  "GET /api/app/teams/:key/members/addable": "requireTeam(actor, key, admin): team admins only; lists only members of the caller's own workspace (tested)",
  "POST /api/app/teams/:key/members": "requireTeam(actor, key, admin); the person must be a member of the caller's workspace, so another workspace's user is a 404 (tested)",
  "PATCH /api/app/teams/:key/members/:userId": "requireTeam(actor, key, admin); scoped to that team's rows; the last admin cannot be demoted (tested)",
  "DELETE /api/app/teams/:key/members/:userId": "requireTeam(actor, key, admin), or read to leave yourself; scoped to that team's rows; the last admin cannot go (tested)",
  "POST /api/app/teams/:key/join": "workspace owners and admins only; the team is found inside the caller's own workspace, so another workspace's team is a 404; audited and shown in the team's activity (tested)",
  "GET /api/app/access/teams": "workspace owners and admins only; team names and admin names of the caller's own workspace, nothing inside a team (tested)",
  "GET /api/app/access/audit": "workspace owners and admins only; filtered by the caller's workspace id (tested)",
  "PATCH /api/app/workspace/members/:userId": "owners and admins (only an owner can make or change an owner); members.updateMember is scoped by the caller's workspace id, so another workspace's user matches nothing and is a 404 (tested)",
  "DELETE /api/app/workspace/members/:userId": "owners and admins (only an owner can remove an owner); refused while the person is the only admin of a team; members.removeMember is scoped by the caller's workspace id, so another workspace's user is a 404 (tested)",
  "GET /api/app/agents": "the keys of the caller's own workspace (where workspace_id is the session's workspace) and the printed commands; a key value is never returned (tested)",
  "POST /api/app/agents/mark-all-seen": "svc.markAllSeen(actor): keys and teams of the actor's workspace only; another workspace's key id is a 404 (tested)",
  "POST /api/app/keys": "creates a key in the caller's own workspace; the secret is in this response only and 10 an hour per person (tested)",
  "DELETE /api/app/keys/:id": "members.revokeApiKey is scoped by key id AND the caller's workspace id; another workspace's key is a 404 and keeps working (tested)",
  "PATCH /api/app/keys/:id": "scoped by key id AND the caller's workspace id; another workspace's key is a 404 (tested)",
  "GET /api/app/invites": "listInvites(issuer): a workspace's join invites for its owners only, new-workspace invites for instance admins only (404 for anyone else) (tested)",
  "POST /api/app/invites": "createInvite(issuer): an owner of the caller's own workspace (join) or an instance admin (new_workspace); 20 an hour per person (tested)",
  "DELETE /api/app/invites/:id": "revokeInvite(issuer), scoped like the list; another workspace's invite is a 404 and stays pending (tested)",
  "POST /api/app/invites/peek": "public, rate limited per address; finds one invite by the hash of its token; the same answer for every bad link (tested)",
  "POST /api/app/invites/accept": "public, rate limited per address; the invite fixes the email, workspace and role, none is taken from the request; one use only (tested)",
  "GET /api/app/admin/workspaces": "instance admins only (a 404 for anyone else); names, emails and counts, never what a workspace wrote (tested)",
  "GET /api/app/admin/workspaces/:id": "instance admins only (a 404 for anyone else); metadata only (tested)",
  "POST /api/app/admin/workspaces/:id/suspend": "instance admins only; needs the workspace's exact name; refuses the admin's own workspace (tested)",
  "POST /api/app/admin/workspaces/:id/restore": "instance admins only (tested)",
  "GET /api/app/teams/:key/board": "boardView(actor): the team is resolved through requireTeam(actor), so another workspace's is a 404; members are this workspace's memberships only (tested)",
  "POST /api/app/teams/:key/tickets": "svc.createTicket(actor): the team through requireTeam(actor) (another workspace's is a 404), the column resolved inside that team, the assignee must be a member of the actor's workspace (tested)",
  "GET /api/app/teams/:key/queue": "svc.queueStatus(actor): the team through requireTeam(actor); the keys are this workspace's (tested)",
  "GET /api/app/tickets/:ref": "svc.getTicket(actor): resolveTicket joins the team and requires its workspace to be the actor's, so another workspace's ticket is a 404 (tested, including two workspaces with the same key)",
  "PATCH /api/app/tickets/:ref": "svc.updateTicket(actor): resolveTicket is workspace scoped; a stale version is a 409 that returns the trimmed current ticket and changes nothing; the assignee must be on the actor's workspace (tested)",
  "POST /api/app/tickets/:ref/move": "svc.moveTicket(actor): resolveTicket is workspace scoped and the column is resolved inside the ticket's own team (tested)",
  "DELETE /api/app/tickets/:ref": "svc.deleteTicket(actor): resolveTicket is workspace scoped (tested)",
  "POST /api/app/tickets/:ref/comments": "svc.addComment(actor): resolveTicket is workspace scoped (tested)",
  "PUT /api/app/tickets/:ref/nodes/:nodeId": "svc.linkTicketNode(actor): the ticket is workspace scoped and the node is resolved inside the ticket's own team, so another workspace's node is a 404 (tested)",
  "DELETE /api/app/tickets/:ref/nodes/:nodeId": "svc.linkTicketNode(actor, unlink): same scoping as linking (tested)",
  "GET /api/app/teams/:key/graph": "graphView(actor): the team through requireTeam(actor) (another workspace's is a 404); every table is read by that team's id (tested)",
  "PUT /api/app/teams/:key/nodes": "svc.upsertNode(actor): the team through requireTeam(actor); a node is found only inside that team, so another workspace's node id is a 404; a stale version is a 409 that changes nothing (tested)",
  "DELETE /api/app/teams/:key/nodes/:id": "svc.deleteNode(actor): the node is resolved inside the actor's team, so another workspace's is a 404 (tested)",
  "POST /api/app/teams/:key/nodes/:id/fresh": "svc.markFresh(actor): the node is resolved inside the actor's team (tested)",
  "PUT /api/app/teams/:key/layout": "svc.saveLayout(actor): every update is by node id AND the actor's team id, so another workspace's node ids move nothing (tested)",
  "POST /api/app/teams/:key/edges": "svc.upsertEdge(actor): both ends are resolved inside the actor's team, so a node of another workspace is a 404 (tested)",
  "DELETE /api/app/teams/:key/edges/:id": "svc.deleteEdge(actor): deleted by edge id AND the actor's team id, so another workspace's edge is untouched (tested)",
  "PUT /api/app/teams/:key/flows": "svc.upsertFlow(actor): the flow is matched inside the actor's team and its steps resolve nodes inside it; a stale version is a 409 (tested)",
  "DELETE /api/app/teams/:key/flows/:id": "svc.deleteFlow(actor): matched inside the actor's team, so another workspace's flow is a 404 (tested)",
  "PUT /api/app/teams/:key/decisions": "svc.upsertDecision(actor): numbers are per team, matched inside the actor's team; a stale version is a 409 (tested)",
  "PUT /api/app/teams/:key/terms/:term": "svc.upsertTerm(actor): matched by name inside the actor's team (tested with the same word in two workspaces)",
  "DELETE /api/app/teams/:key/terms/:term": "svc.deleteTerm(actor): matched inside the actor's team (tested)",
  "POST /api/app/teams/:key/drafts/:id/resolve": "resolveDraft(actor): the draft must belong to the actor's team and be pending, so another workspace's is a 404 and stays pending (tested)",
  "POST /api/app/teams/:key/ask": "askAs(actor): the team is resolved first (another workspace's is a 404 before anything is counted or called); the prompt is built from the actor's own team only; 20 questions per person per 10 minutes; the server's API key is in no answer (tested against a fake Claude)",
  "GET /api/app/teams/:key/activity": "activityView(actor): svc.listEvents resolves the team through requireTeam(actor); events are by that team's id; data is cut down to what the page links with (tested)",
  "GET /api/app/teams/:key/docs": "docsIndex(human): svc.listDocs and svc.getGraph resolve the team through requireTeam(actor); members are those of the person's own workspace (tested)",
  "GET /api/app/teams/:key/docs/:ref": "svc.getDoc(actor): the doc is resolved inside the actor's team (by id or slug), so another workspace's doc is a 404 (tested)",
  "POST /api/app/teams/:key/docs": "svc.createDoc(actor): the team through requireTeam(actor); the parent is resolved inside it, so another workspace's doc cannot be a parent (tested)",
  "PATCH /api/app/teams/:key/docs/:ref": "svc.updateDoc(actor): the doc is resolved inside the actor's team; a stale version is a 409 returning the trimmed current doc and changes nothing (tested)",
  "POST /api/app/teams/:key/docs/:ref/fresh": "svc.markDocFresh(actor): resolved inside the actor's team (tested)",
  "GET /api/app/teams/:key/docs/:ref/anchor-suggestions": "svc.suggestDocAnchors(actor): the doc and its linked nodes are read inside the actor's team (tested)",
  "POST /api/app/teams/:key/docs/:ref/move": "svc.moveDoc(actor): doc and new parent are both resolved inside the actor's team; cycles are refused (tested)",
  "DELETE /api/app/teams/:key/docs/:ref": "svc.deleteDoc(actor): resolved inside the actor's team (tested)",
  "PUT /api/app/teams/:key/docs/:ref/nodes/:nodeId": "svc.linkDocNode(actor): the doc and the node are both resolved inside the actor's team, so another workspace's node is a 404 (tested)",
  "DELETE /api/app/teams/:key/docs/:ref/nodes/:nodeId": "svc.linkDocNode(actor, unlink): same scoping as linking (tested)",
  "GET /api/app/teams/:key/repositories": "svc.listRepositories(actor): rows are selected by the team found through requireTeam(actor); the answer is a view without installation ids (tested)",
  "POST /api/app/teams/:key/repositories": "svc.createRepository(actor): the team through requireTeam(actor); humans only (tested)",
  "GET /api/app/teams/:key/repositories/github": "githubStatus(human): installations are listed by the person's workspace id, and only for owners; repositories GitHub lists are asked per installation (tested against a fake GitHub)",
  "POST /api/app/teams/:key/repositories/github": "connectGithubRepository(actor): owners only, and the installation must be one of the actor's workspace (ADR-12); name and branch are read from GitHub (tested against a fake GitHub)",
  "PATCH /api/app/teams/:key/repositories/:id": "svc.updateRepository(actor): the repository is resolved inside the actor's team (tested)",
  "POST /api/app/teams/:key/repositories/:id/retire": "svc.retireRepository(actor): resolved inside the actor's team (tested)",
  "GET /api/app/teams/:key/repositories/:id/tree": "browseRepoTreeAs(actor): the repository is looked up in the actor's own team, so another workspace's repository id is a 404 and no tree is fetched (tested)",
  "GET /api/app/teams/:key/onboarding": "onboardingPage(actor): the team through requireTeam(actor); the commands carry no API key (tested)",
  "POST /api/app/teams/:key/onboarding/concept": "createConceptAs(actor): the team through requireTeam(actor); the node is written to that team (tested)",
  "GET /api/app/dashboard/:widget": "metrics.*(actor): every query is by the actor's workspace id and limited to the teams the person is a member of; `?team=KEY` is resolved through requireTeam(actor, key), so another workspace's team, one the person is not in, a malformed value or a repeated parameter is a 404, and the snapshot is intersected with what they can open anyway; the Focus widget needs a team; an unknown widget is a 404 (tested)",
};

const controllerFiles = (dir: string) => walk(dir).filter((f) => f.endsWith(".controller.ts"));
const prefixOf = (src: string) => /@Controller\(\s*(?:"([^"]*)")?\s*\)/.exec(src)?.[1] ?? "";
const routesIn = (src: string): string[] =>
  [...src.matchAll(/@(Get|Post|Put|Patch|Delete)\(\s*(?:"([^"]*)")?\s*\)/g)].map((m) => `${m[1].toUpperCase()} /${[prefixOf(src), m[2] ?? ""].filter(Boolean).join("/").replace(/^\/+/, "")}`);
const routesOf = (dir: string): string[] => controllerFiles(dir).flatMap((f) => routesIn(fs.readFileSync(f, "utf8"))).sort();

describe("every API route must be audited", () => {
  test("each route a controller serves has an entry saying how it is scoped", () => {
    const routes = routesOf("apps/api/src");
    assert.ok(routes.length >= 15, `found only ${routes.length} routes; the scan may be broken`);
    const missing = routes.filter((r) => !(r in API_ROUTE_AUDIT));
    assert.deepEqual(missing, [], `API routes without an isolation audit entry: ${missing.join(", ")}`);
  });

  test("no entry is left for a route that no longer exists", () => {
    const routes = routesOf("apps/api/src");
    const stale = Object.keys(API_ROUTE_AUDIT).filter((r) => !routes.includes(r));
    assert.deepEqual(stale, [], `audit entries for routes that are gone: ${stale.join(", ")}`);
  });

  test("every /api/app controller uses @AppEndpoints(), and every route has SessionGuard unless it is one of the open sign-in or invite routes", () => {
    const open = new Set([
      "GET /api/app/auth/options",
      "POST /api/app/auth/login",
      "POST /api/app/auth/signup",
      "POST /api/app/auth/logout",
      "POST /api/app/invites/peek",
      "POST /api/app/invites/accept",
    ]);
    let checked = 0;
    for (const f of controllerFiles("apps/api/src")) {
      const src = fs.readFileSync(f, "utf8");
      const prefix = prefixOf(src);
      if (!prefix.startsWith("api/app")) continue;
      checked++;
      assert.match(src, /@AppEndpoints\(\)/, `${f} must use @AppEndpoints() for CSRF and the error envelope`);
      if (/@UseGuards\(SessionGuard\)\s*\n\s*export class/.test(src)) continue; // the whole controller needs a signed-in person
      // Otherwise decide route by route: a method's decorators all sit between the previous method's signature and its own.
      let from = 0;
      for (const sig of src.matchAll(/^ {2}(?:async )?\w+\(.*$/gm)) {
        const chunk = src.slice(from, sig.index! + sig[0].length);
        from = sig.index! + sig[0].length;
        for (const m of chunk.matchAll(/@(Get|Post|Put|Patch|Delete)\(\s*(?:"([^"]*)")?\s*\)/g)) {
          const route = `${m[1].toUpperCase()} /${[prefix, m[2] ?? ""].filter(Boolean).join("/")}`;
          if (open.has(route)) continue;
          assert.match(chunk, /@UseGuards\(SessionGuard\)/, `${route} in ${f} needs @UseGuards(SessionGuard), or must be listed as an open route here`);
        }
      }
    }
    assert.ok(checked >= 8, "no /api/app controllers found; the scan may be broken");
  });
});
