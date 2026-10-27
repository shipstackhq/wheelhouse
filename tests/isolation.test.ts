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
import { and, eq, inArray } from "drizzle-orm";
import { getDb, schema } from "../apps/api/src/db";
import type { Actor } from "../apps/api/src/common/actor";
import { actorForKey, humanFromSession, userForSessionToken } from "../apps/api/src/modules/auth/auth.legacy";
import { sha256 } from "../apps/api/src/common/crypto";
import { ServiceError } from "../apps/api/src/common/service-error";
import { listEvents, markAllSeen, queueStatus, removeSession } from "../apps/api/src/lib/service-queue";
import { createDoc, getDoc, linkDocNode, markDocFresh } from "../apps/api/src/modules/docs/docs.legacy";
import { createRepository, findOrCreateRepository, listRepositories, retireRepository, updateRepository } from "../apps/api/src/modules/github/github.legacy";
import { linkIssueNode } from "../apps/api/src/modules/issues/issues.legacy";
import { addComment, createIssue, getIssue, updateIssue } from "../apps/api/src/modules/issues/issues.legacy";
import { upsertDecision, upsertTerm } from "../apps/api/src/modules/map/map.legacy";
import { reportChanges } from "../apps/api/src/modules/map/map.legacy";
import { listStaleDocs, resolveDocDraft } from "../apps/api/src/modules/docs/docs.legacy";
import { upsertEdge, upsertFlow, upsertNode } from "../apps/api/src/modules/map/map.legacy";
import { createTeam, deleteTeam, requireTeam } from "../apps/api/src/modules/teams/teams.legacy";
import { scopeKeyToAllTeams } from "../apps/api/src/modules/auth/auth.legacy";
import * as cycles from "../apps/api/src/modules/issues/issues.legacy";
import * as projects from "../apps/api/src/modules/issues/issues.legacy";
import * as initiatives from "../apps/api/src/modules/issues/issues.legacy";
import * as members from "../apps/api/src/modules/auth/auth.legacy";
import { runTool, tools } from "../apps/api/src/lib/tools";
import { askMap } from "../apps/api/src/modules/map/map.legacy";
import { briefing, issueContext } from "../apps/api/src/modules/dashboard/dashboard.legacy";
import { MetricsService } from "../apps/api/src/modules/dashboard/metrics.service";
import { resolveDraft } from "../apps/api/src/modules/map/map.legacy";
import * as sync from "../apps/api/src/modules/map/map.legacy";
import { testApp } from "../apps/api/src/test/app";
const metrics = (await testApp()).get(MetricsService);

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
  issueRef: string;
  issueId: string;
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
  projectId: string;
  projectName: string;
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
  const team = await createTeam(human, { name: `${tag} team`, key: teamKey });
  // Both workspaces also have a team with the same key, to prove keys are per workspace.
  await createTeam(human, { name: `${tag} shared-key team`, key: "SH" });
  const t = await createIssue(human, teamKey, { title: `${tag} issue`, body: `${tag} body`, priority: "high" });
  await createIssue(human, "SH", { title: `${tag} shared issue` });
  await scopeKeyToAllTeams(db, k.id, workspace.id);
  await addComment(human, t.ref, `${tag} comment`);
  return { workspaceId: workspace.id, owner: human, ownerEmail, ownerId: owner.id, agent, keyId: k.id, key, teamKey, teamId: team.id, issueRef: t.ref, issueId: t.id, tag };
}

async function seedMap(s: Awaited<ReturnType<typeof seedSide>>) {
  const k = s.teamKey;
  const sys = await upsertNode(s.owner, k, { name: `${s.tag} system`, layer: "system", kind: "service", summary: `${s.tag} summary`, anchors: ["src/a/**"] });
  const concept = await upsertNode(s.owner, k, { name: `${s.tag} concept`, layer: "concept", kind: "concept", summary: `${s.tag} concept` });
  const data = await upsertNode(s.owner, k, {
    name: `${s.tag} table`,
    layer: "data",
    kind: "table",
    columns: [{ name: "id", type: "uuid", pk: true }] as never,
  });
  await upsertEdge(s.owner, k, { from: sys.id, to: concept.id, kind: "implements" });
  await linkIssueNode(s.owner, s.issueRef, sys.name);
  await upsertFlow(s.owner, k, { name: `${s.tag} flow`, steps: [{ node: sys.name, title: `${s.tag} step` }] });
  await upsertDecision(s.owner, k, { title: `${s.tag} decision`, nodes: [sys.name] });
  await upsertTerm(s.owner, k, { term: `${s.tag} term`, definition: `${s.tag} definition`, node: sys.name });
  const doc = await createDoc(s.owner, k, { title: `${s.tag} doc`, body: `${s.tag} body with a secret word` });
  await linkDocNode(s.owner, k, doc.id, sys.name);
  return { sys, concept, data, doc };
}

const fingerprint = async (s: { workspaceId: string; teamId: string; keyId: string }) => {
  const db = await getDb();
  const ps = (await db.select({ id: schema.teams.id }).from(schema.teams).where(eq(schema.teams.workspaceId, s.workspaceId))).map((p) => p.id);
  const keys = (await db.select({ id: schema.apiKeys.id }).from(schema.apiKeys).where(eq(schema.apiKeys.workspaceId, s.workspaceId))).map((p) => p.id);
  const tix = ps.length ? (await db.select({ id: schema.issues.id }).from(schema.issues).where(inArray(schema.issues.teamId, ps))).map((t) => t.id) : [];
  const ns = ps.length ? (await db.select({ id: schema.nodes.id }).from(schema.nodes).where(inArray(schema.nodes.teamId, ps))).map((t) => t.id) : [];
  const byTeam = <T extends { teamId: unknown }>(tbl: T & { teamId: never }) => ps.length ? db.select().from(tbl as never).where(inArray(tbl.teamId as never, ps)) : [];
  const parts = {
    workspaces: await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, s.workspaceId)),
    members: await db.select().from(schema.memberships).where(eq(schema.memberships.workspaceId, s.workspaceId)),
    keys: await db.select().from(schema.apiKeys).where(eq(schema.apiKeys.workspaceId, s.workspaceId)),
    teams: await db.select().from(schema.teams).where(eq(schema.teams.workspaceId, s.workspaceId)),
    columns: await byTeam(schema.statuses as never),
    issues: await byTeam(schema.issues as never),
    comments: tix.length ? await db.select().from(schema.comments).where(inArray(schema.comments.issueId, tix)) : [],
    nodes: await byTeam(schema.nodes as never),
    edges: await byTeam(schema.edges as never),
    flows: await byTeam(schema.flows as never),
    decisions: await byTeam(schema.decisions as never),
    terms: await byTeam(schema.terms as never),
    docs: await byTeam(schema.docs as never),
    issueNodes: tix.length ? await db.select().from(schema.issueNodes).where(inArray(schema.issueNodes.issueId, tix)) : [],
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
  const repo = await createRepository(a.owner, a.teamKey, { displayName: "A-SECRET backend", role: "backend", slug: `a-secret-repo-${RUN}` });
  const [spare] = await db
    .insert(schema.apiKeys)
    .values({ workspaceId: a.workspaceId, name: "A-SECRET spare key", prefix: "wh_spare", keyHash: sha256(`spare-${RUN}`), createdBy: a.ownerId })
    .returning();
  await scopeKeyToAllTeams(db, spare.id, a.workspaceId);
  await createIssue(a.agent, a.teamKey, { title: "A-SECRET agent issue" }); // an event written by A's agent
  const project = await projects.createProject(a.owner, { name: "A-SECRET project", leadTeam: a.teamKey });
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
    projectId: project.id,
    projectName: project.name,
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
  get_briefing: () => [{ team: A.teamKey }, { team: A.teamId }],
  get_changes: () => [{ team: A.teamKey }, { team: A.teamId }, { team: A.teamKey, ack: 999999 }],
  list_issues: () => [{ team: A.teamKey }, { team: A.teamId }],
  get_issue: () => [{ ref: A.issueRef }, { ref: A.issueId }],
  create_issue: () => [{ team: A.teamKey, title: "B writes into A" }, { team: A.teamId, title: "B writes into A", link_nodes: [A.nodeName] }],
  update_issue: () => [
    { ref: A.issueRef, title: "hijacked" },
    { ref: A.issueId, body: "hijacked" },
    { ref: A.issueRef, status: "Done" },
    { ref: A.issueRef, assignee: "me" },
    { ref: A.issueRef, link_nodes: [A.nodeName] },
  ],
  comment: () => [{ ref: A.issueRef, body: "B comments on A" }],
  get_project: () => [{ ref: A.projectId }, { ref: A.projectName }],
  get_cycle: () => [{ team: A.teamKey }, { team: A.teamKey, which: 1 }],
  plan: () => [
    { changes: [{ op: "create_cycle" as const, team: A.teamKey }] },
    { changes: [{ op: "update_cycle" as const, team: A.teamKey, number: 1, name: "hijacked" }] },
    { changes: [{ op: "create_project" as const, name: "B in A", lead_team: A.teamKey }] },
    { changes: [{ op: "update_project" as const, project: A.projectId, name: "hijacked" }] },
    { changes: [{ op: "create_milestone" as const, project: A.projectId, name: "B milestone" }] },
    { changes: [{ op: "update_milestone" as const, project: A.projectName, milestone: "x", name: "hijacked" }] },
  ],
  get_map: () => [{ team: A.teamKey }, { team: A.teamKey, layer: "data" as const }, { team: A.teamKey, node: A.nodeName }, { team: A.teamKey, node: A.nodeId }, { team: A.teamKey, flow: A.flowName }],
  update_map: () => [
    { team: A.teamKey, changes: [{ op: "upsert_node" as const, name: "B node" }] },
    { team: A.teamKey, changes: [{ op: "upsert_node" as const, name: A.nodeName, id: A.nodeId, summary: "hijacked" }] },
    { team: A.teamKey, changes: [{ op: "remove_node" as const, node: A.nodeName }] },
    { team: A.teamKey, changes: [{ op: "remove_node" as const, node: A.nodeId }] },
    { team: A.teamKey, changes: [{ op: "upsert_edge" as const, from: A.nodeName, to: A.dataName }] },
    { team: A.teamKey, changes: [{ op: "remove_edge" as const, from: A.nodeName, to: "A-SECRET concept" }] },
    { team: A.teamKey, changes: [{ op: "upsert_table" as const, name: A.dataName, summary: "hijacked", columns: [{ name: "id", type: "uuid" }] }] },
    { team: A.teamKey, changes: [{ op: "upsert_flow" as const, name: A.flowName, description: "hijacked" }] },
    { team: A.teamKey, changes: [{ op: "remove_flow" as const, flow: A.flowName }] },
  ],
  get_stale: () => [{ team: A.teamKey }],
  mark_fresh: () => [{ team: A.teamKey, refs: [A.nodeName] }, { team: A.teamKey, refs: [`docs/${A.docSlug}`, A.docId] }],
  list_knowledge: () => [{ team: A.teamKey, kind: "docs" as const }, { team: A.teamId, kind: "decisions" as const }, { team: A.teamKey, kind: "terms" as const }],
  get_doc: () => [{ team: A.teamKey, ref: `docs/${A.docSlug}` }, { team: A.teamKey, ref: A.docId }],
  write_doc: () => [
    { team: A.teamKey, title: "B doc in A" },
    { team: A.teamKey, ref: `docs/${A.docSlug}`, title: "hijacked" },
    { team: A.teamKey, ref: A.docId, body: "hijacked" },
    { team: A.teamKey, ref: A.docId, link_nodes: [A.nodeName], unlink_nodes: [A.nodeName] },
  ],
  record_decision: () => [{ team: A.teamKey, number: 1, title: "hijacked" }, { team: A.teamKey, title: "B decision in A" }],
  define_term: () => [{ team: A.teamKey, term: A.termName, definition: "hijacked" }],
  resume_session: () => [{ team: A.teamKey, mode: "replay" as const }],
  session_sync: () => [{ team: A.teamKey, session: "b-session", files: ["src/a/x.ts"] }],
  session_status: () => [{ team: A.teamKey, session: A.sessionId }],
  session_end: () => [{ team: A.teamKey, session: A.sessionId }],
  land_changes: () => [{ team: A.teamKey, files: { "src/a/secret.ts": "b".repeat(40) } }],
  report_changes: () => [{ team: A.teamKey, files: ["src/a/secret.ts"] }],
} satisfies Record<ToolName, () => Attack[]>;

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
            assert.ok(error instanceof ServiceError, `${label}: expected a clean refusal, got ${error}`);
            assert.ok(["not_found", "forbidden", "invalid", "conflict"].includes(error.code), `${label}: ${error.code}`);
            assert.ok(!isZodMessage(error.message), `${label}: refused only because the arguments were malformed: ${error.message}`);
            assert.ok(!MARK.test(error.message), `${label}: the refusal leaks workspace A data: ${error.message}`);
          } else {
            assert.fail(`${label}: succeeded against workspace A's identifiers`);
            const text = JSON.stringify(result);
            assert.ok(!MARK.test(text), `${label}: returned workspace A data`);
            for (const id of [A.teamId, A.issueId, A.nodeId, A.ownerId, A.keyId]) assert.ok(!text.includes(id), `${label}: returned an id of workspace A`);
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

describe("a key scoped to one team of a workspace (WH-120)", () => {
  let narrow: Actor; // A's key, scoped to A's team SH only
  let sh: { id: string };
  before(async () => {
    const db = await getDb();
    const key = `wh_${crypto.randomBytes(18).toString("base64url")}`;
    const [k] = await db.insert(schema.apiKeys).values({ workspaceId: A.workspaceId, name: "A narrow key", prefix: key.slice(0, 10), keyHash: sha256(key), createdBy: A.ownerId }).returning();
    [sh] = await db.select({ id: schema.teams.id }).from(schema.teams).where(and(eq(schema.teams.workspaceId, A.workspaceId), eq(schema.teams.key, "SH")));
    await db.insert(schema.apiKeyTeams).values({ apiKeyId: k.id, teamId: sh.id, workspaceId: A.workspaceId });
    narrow = { kind: "agent", id: k.id, name: "A narrow key", workspaceId: A.workspaceId };
  });

  test("every tool, called with the identifiers of A's other team: refused, nothing read, nothing changed", async () => {
    const before = await fingerprint(A);
    for (const name of Object.keys(tools) as ToolName[]) {
      for (const args of attacks[name]()) {
        const label = `${name}(${JSON.stringify(args).slice(0, 80)}) as a key scoped to SH`;
        let error: unknown;
        let result: unknown;
        try {
          result = await runTool(narrow, name, args);
        } catch (e) {
          error = e;
        }
        if (error) {
          assert.ok(error instanceof ServiceError, `${label}: expected a clean refusal, got ${error}`);
          assert.ok(["not_found", "forbidden", "invalid", "conflict"].includes(error.code), `${label}: ${error.code}`);
          assert.ok(!isZodMessage(error.message), `${label}: refused only because the arguments were malformed: ${error.message}`);
        } else {
          assert.fail(`${label}: succeeded against a team the key is not scoped to: ${JSON.stringify(result).slice(0, 120)}`);
        }
      }
    }
    assert.equal(await fingerprint(A), before, "team AA's data is exactly as it was");
  });

  test("it lists only its own team, and reads and writes there", async () => {
    const listed = (await runTool(narrow, "get_briefing", {})) as { teams: { key: string }[] };
    assert.deepEqual(listed.teams.map((p) => p.key), ["SH"]);
    assert.ok(!JSON.stringify(listed).includes(A.teamId));
    assert.equal(((await runTool(narrow, "get_issue", { ref: "SH-1" })) as { issue: { title: string } }).issue.title, "A-SECRET shared issue");
    await runTool(narrow, "comment", { ref: "SH-1", body: "from the narrow key" });
    await assert.rejects(runTool(narrow, "comment", { ref: A.issueRef, body: "no" }), (e: unknown) => e instanceof ServiceError && e.code === "not_found");
  });

  test("a key with no team and a key scoped to AA each reach only what they are given", async () => {
    const db = await getDb();
    const mk = async (name: string, teams: string[]): Promise<Actor> => {
      const key = `wh_${crypto.randomBytes(18).toString("base64url")}`;
      const [k] = await db.insert(schema.apiKeys).values({ workspaceId: A.workspaceId, name, prefix: key.slice(0, 10), keyHash: sha256(key), createdBy: A.ownerId }).returning();
      for (const t of teams) await db.insert(schema.apiKeyTeams).values({ apiKeyId: k.id, teamId: t, workspaceId: A.workspaceId });
      return { kind: "agent", id: k.id, name, workspaceId: A.workspaceId };
    };
    const none = await mk("A none key", []);
    const aa = await mk("A AA key", [A.teamId]);
    assert.deepEqual(((await runTool(none, "get_briefing", {})) as { teams: unknown[] }).teams, []);
    await assert.rejects(runTool(none, "get_issue", { ref: A.issueRef }), (e: unknown) => e instanceof ServiceError && e.code === "not_found");
    assert.equal(((await runTool(aa, "get_issue", { ref: A.issueRef })) as { issue: { title: string } }).issue.title, "A-SECRET issue");
    await assert.rejects(runTool(aa, "get_issue", { ref: "SH-1" }), (e: unknown) => e instanceof ServiceError && e.code === "not_found");
  });

  test("the GitHub actor of one team reaches no other team, even of its own workspace", async () => {
    const { githubActor } = await import("../apps/api/src/modules/github/deliveries.service");
    const gh = githubActor(A.workspaceId, A.teamId);
    assert.ok((await requireTeam(gh, A.teamKey)).id);
    await assert.rejects(requireTeam(gh, "SH"), (e: unknown) => e instanceof ServiceError && e.code === "not_found");
    await assert.rejects(requireTeam(githubActor(B.workspaceId, B.teamId), A.teamKey), (e: unknown) => e instanceof ServiceError && e.code === "not_found");
  });

  test("one GitHub installation linked by both workspaces: each sees only its own link, and unlinking B's leaves A's", async () => {
    const { ConnectService } = await import("../apps/api/src/modules/github/connect.service");
    const connect = (await testApp()).get(ConnectService);
    const db = await getDb();
    const link = (workspaceId: string, connectedBy: string) => db.insert(schema.githubInstallations).values({ installationId: "7777", workspaceId, accountLogin: "shared", accountType: "Organization", connectedBy });
    await link(A.workspaceId, A.ownerId);
    await link(B.workspaceId, B.owner.id);
    assert.equal((await connect.listInstallations(A.owner)).length, 1);
    assert.equal((await connect.listInstallations(B.owner)).length, 1);
    await connect.unlinkInstallation(B.owner, "7777");
    assert.equal((await connect.listInstallations(B.owner)).length, 0);
    assert.equal((await connect.listInstallations(A.owner)).length, 1);
    await db.delete(schema.githubInstallations).where(eq(schema.githubInstallations.installationId, "7777"));
  });
});

describe("the attacks are real: the same calls work for the owner", () => {
  test("workspace A's own agent and human can do what B was refused", async () => {
    assert.equal((await runTool(A.agent, "get_issue", { ref: A.issueRef }) as { issue: { title: string } }).issue.title, "A-SECRET issue");
    await runTool(A.owner, "get_map", { team: A.teamKey, node: A.nodeName });
    await runTool(A.agent, "list_issues", { team: A.teamId });
    await runTool(A.agent, "session_status", { team: A.teamKey, session: A.sessionId }).catch((e) => assert.ok(e instanceof ServiceError));
  });
});

describe("team keys are per workspace", () => {
  test("two workspaces with a team called SH each see their own issues", async () => {
    const a = (await runTool(A.owner, "get_issue", { ref: "SH-1" })) as { issue: { title: string } };
    const b = (await runTool(B.owner, "get_issue", { ref: "SH-1" })) as { issue: { title: string } };
    assert.equal(a.issue.title, "A-SECRET shared issue");
    assert.equal(b.issue.title, "B-OWN shared issue");
  });

});

describe("what B can see is only B's", () => {
  test("B's own board, graph, activity, queue, briefing and issue context hold nothing of A's", async () => {
    const calls: Promise<unknown>[] = [
      runTool(B.owner, "list_issues", { team: B.teamKey }),
      runTool(B.owner, "get_map", { team: B.teamKey }),
      runTool(B.owner, "get_briefing", { team: B.teamKey }),
      runTool(B.agent, "get_changes", { team: B.teamKey }),
      briefing(B.agent, B.teamKey),
      issueContext(B.agent, B.issueRef),
      listEvents(B.owner, B.teamKey),
      queueStatus(B.owner, B.teamKey),
    ];
    for (const r of await Promise.all(calls)) {
      const text = JSON.stringify(r);
      assert.ok(text.length > 20, "a real answer, not an empty one");
      assert.ok(!MARK.test(text), "no workspace A data");
      for (const id of [A.teamId, A.issueId, A.nodeId, A.ownerId, A.keyId, A.workspaceId]) assert.ok(!text.includes(id));
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
    const changes = (await runTool(B.agent, "get_changes", { team: B.teamKey })) as { changes: unknown[] };
    assert.ok(!MARK.test(JSON.stringify(changes)));
    await assert.rejects(runTool(B.agent, "get_changes", { team: A.teamKey }), ServiceError);
  });
});

describe("briefing, context and Ask", () => {
  test("briefing and issue context refuse workspace A's team and issue", async () => {
    await assert.rejects(briefing(B.agent, A.teamKey), (e: unknown) => e instanceof ServiceError && e.code === "not_found");
    await assert.rejects(issueContext(B.agent, A.issueRef), (e: unknown) => e instanceof ServiceError && e.code === "not_found");
    await assert.rejects(issueContext(B.owner, A.issueId), (e: unknown) => e instanceof ServiceError && e.code === "not_found");
  });

  test("Ask refuses workspace A's team before it would call the model", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-test-not-used";
    try {
      await assert.rejects(askMap(B.owner, A.teamKey, "what is in here?"), (e: unknown) => e instanceof ServiceError && e.code === "not_found");
      await assert.rejects(askMap(B.owner, A.teamId, "x", A.nodeId), (e: unknown) => e instanceof ServiceError && e.code === "not_found");
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });
});

describe("human-only and queue actions that take ids", () => {
  test("B cannot reset A's agent queue, remove A's session or resolve A's draft", async () => {
    const before = await fingerprint(A);
    await assert.rejects(markAllSeen(B.owner, { keyId: A.keyId }), (e: unknown) => e instanceof ServiceError && e.code === "not_found");
    await assert.rejects(markAllSeen(B.owner, { keyId: A.keyId, teamRef: A.teamKey }), ServiceError);
    await assert.rejects(markAllSeen(B.owner, { teamRef: A.teamKey }), ServiceError);
    await assert.rejects(removeSession(B.owner, A.teamKey, A.sessionId), ServiceError);
    await assert.rejects(removeSession(B.owner, B.teamKey, A.sessionId), (e: unknown) => e instanceof ServiceError && e.code === "not_found");
    await assert.rejects(resolveDraft(B.owner, A.teamKey, A.draftId, "publish"), ServiceError);
    await assert.rejects(resolveDraft(B.owner, B.teamKey, A.draftId, "discard"), (e: unknown) => e instanceof ServiceError && e.code === "not_found");
    await assert.rejects(deleteTeam(B.owner, A.teamKey), ServiceError);
    assert.equal(await fingerprint(A), before);
  });

  test("a reset of 'all keys' by B only touches B's keys", async () => {
    const before = await fingerprint(A);
    const r = await markAllSeen(B.owner, {});
    assert.ok(r.ok);
    assert.equal(await fingerprint(A), before);
  });

  test("B's agent using A's session id is refused and A's session is unchanged", async () => {
    const before = await fingerprint(A);
    for (const [tool, args] of [
      ["get_changes", {}],
      ["get_changes", { ack: 5 }],
      ["session_sync", {}],
      ["session_end", {}],
      ["session_status", {}],
    ] as const) {
      await assert.rejects(runTool(B.agent, tool, { team: B.teamKey, ...args, session: A.sessionId }), (e: unknown) => e instanceof ServiceError, tool);
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

  test("an issue cannot be assigned to someone outside the workspace (regression)", async () => {
    const before = await fingerprint(A);
    await assert.rejects(updateIssue(B.owner, B.issueRef, { assigneeId: A.ownerId }), (e: unknown) => e instanceof ServiceError && e.code === "invalid");
    await assert.rejects(createIssue(B.owner, B.teamKey, { title: "x", assigneeId: A.ownerId }), (e: unknown) => e instanceof ServiceError && e.code === "invalid");
    await assert.rejects(updateIssue(B.owner, B.issueRef, { assigneeId: "not-a-uuid" }), ServiceError);
    await assert.rejects(updateIssue(B.owner, B.issueRef, { assigneeId: crypto.randomUUID() }), ServiceError);
    const own = await updateIssue(B.owner, B.issueRef, { assigneeId: B.owner.id });
    assert.equal(own.assigneeId, B.owner.id, "an own-workspace assignee still works");
    assert.equal((await updateIssue(B.owner, B.issueRef, { assigneeId: null })).assigneeId, null);
    assert.equal(await fingerprint(A), before);
  });
});

describe("repositories (WH-68)", () => {
  test("B cannot read, edit or retire A's repositories through the service layer", async () => {
    const before = await fingerprint(A);
    await assert.rejects(listRepositories(B.owner, A.teamKey), (e: unknown) => e instanceof ServiceError && e.code === "not_found");
    await assert.rejects(updateRepository(B.owner, A.teamKey, A.repoId, { displayName: "hijacked" }), ServiceError);
    await assert.rejects(updateRepository(B.owner, B.teamKey, A.repoId, { displayName: "hijacked" }), (e: unknown) => e instanceof ServiceError && e.code === "not_found");
    await assert.rejects(retireRepository(B.owner, B.teamKey, A.repoId), (e: unknown) => e instanceof ServiceError && e.code === "not_found");
    await assert.rejects(createRepository(B.agent, B.teamKey, { displayName: "x", role: "backend" }), (e: unknown) => e instanceof ServiceError && e.code === "forbidden");
    const list = await listRepositories(B.owner, B.teamKey);
    assert.ok(!JSON.stringify(list).includes(A.repoId));
    assert.equal(await fingerprint(A), before);
  });

  test("B cannot browse A's connected repo's tree by guessing A's repositoryId (WH-82)", async () => {
    // The web API's repository browse resolves the repository the same way: listRepositories(actor, teamKey)
    // then matches repositoryId against that list. A's repo never appears in B's list, so B's lookup fails
    // closed (not_found) before any GitHub API call would be made — mirrored here at the service layer.
    const bList = await listRepositories(B.owner, B.teamKey);
    assert.ok(!bList.some((r) => r.id === A.repoId), "A's repository must not be visible when listing B's team");
    // Even if B passes A's team key, B isn't a member of A's workspace so requireTeam itself rejects first.
    await assert.rejects(listRepositories(B.owner, A.teamKey), (e: unknown) => e instanceof ServiceError && e.code === "not_found");
  });

  test("B's own repository CRUD works end to end and is scoped to B's team", async () => {
    const r = await createRepository(B.owner, B.teamKey, { displayName: "B frontend", role: "frontend", pathLimit: "apps/web/" });
    assert.equal(r.lifecycle, "live");
    const updated = await updateRepository(B.owner, B.teamKey, r.id, { lifecycle: "being_replaced" });
    assert.equal(updated.lifecycle, "being_replaced");
    const retired = await retireRepository(B.owner, B.teamKey, r.id);
    assert.equal(retired.lifecycle, "retired");
    const list = await listRepositories(B.owner, B.teamKey);
    assert.ok(list.some((x) => x.id === r.id));
  });

  test("find-or-create is per team: the same slug in two teams is two rows, each with its own path limit", async () => {
    const mono = `mono-${RUN}`;
    const r1 = await findOrCreateRepository(A.owner, A.teamId, mono);
    const r2 = await findOrCreateRepository(B.owner, B.teamId, mono);
    assert.notEqual(r1.id, r2.id);
    assert.equal(r1.slug, r2.slug);
    await updateRepository(A.owner, A.teamKey, r1.id, { pathLimit: "packages/billing/" });
    await updateRepository(B.owner, B.teamKey, r2.id, { pathLimit: "packages/auth/" });

    // A landed change under packages/auth/ should only register for the team whose path limit matches it.
    const before1 = (await listRepositories(A.owner, A.teamKey)).find((x) => x.id === r1.id)!.lastEventAt;
    const landed = await sync.land(A.owner, A.teamKey, { files: { "packages/auth/index.ts": "f".repeat(40) }, repository: mono });
    assert.equal(landed.files, 0, "outside A's path limit: nothing lands for A's team");
    const after1 = (await listRepositories(A.owner, A.teamKey)).find((x) => x.id === r1.id)!.lastEventAt;
    assert.equal(before1?.getTime(), after1?.getTime());

    const landedForB = await sync.land(B.owner, B.teamKey, { files: { "packages/auth/index.ts": "f".repeat(40) }, repository: mono });
    assert.equal(landedForB.files, 1, "inside B's path limit: it lands for B's team");
  });
});

describe("doc staleness (WH-64) never crosses workspaces", () => {
  test("report_changes / land for A's anchored path never flags or touches B's doc", async () => {
    const aDoc = await createDoc(A.owner, A.teamKey, { title: "A anchored doc", body: "watches src/shared/x.ts", anchors: ["src/shared/x.ts"] });
    const bDoc = await createDoc(B.owner, B.teamKey, { title: "B anchored doc", body: "watches src/shared/x.ts", anchors: ["src/shared/x.ts"] });
    await reportChanges(A.owner, A.teamKey, { files: ["src/shared/x.ts"], sha: "a".repeat(40) });
    const { doc: aAfter } = await getDoc(A.owner, A.teamKey, aDoc.id);
    const { doc: bAfter } = await getDoc(B.owner, B.teamKey, bDoc.id);
    assert.equal(aAfter.stale, true, "A's own doc is flagged");
    assert.equal(bAfter.stale, false, "B's doc with the identical anchor is untouched by A's report");

    await sync.land(B.owner, B.teamKey, { files: { "src/shared/x.ts": "f".repeat(40) } });
    const { doc: aAfter2 } = await getDoc(A.owner, A.teamKey, aDoc.id);
    assert.equal(aAfter2.stale, true, "B landing the same path never clears or otherwise changes A's doc");
  });

  test("B cannot mark A's doc fresh, resolve A's doc draft, or read A's stale docs", async () => {
    const aDoc = await createDoc(A.owner, A.teamKey, { title: "A fresh-check doc", anchors: ["src/shared/y.ts"] });
    await reportChanges(A.owner, A.teamKey, { files: ["src/shared/y.ts"] });
    const before = await fingerprint(A);
    await assert.rejects(markDocFresh(B.owner, A.teamKey, aDoc.id), (e: unknown) => e instanceof ServiceError && e.code === "not_found");
    await assert.rejects(resolveDocDraft(B.owner, A.teamKey, crypto.randomUUID(), "publish"), ServiceError);
    const bStale = await listStaleDocs(B.owner, B.teamKey);
    assert.ok(!JSON.stringify(bStale).includes(aDoc.id));
    const { doc: stillStale } = await getDoc(A.owner, A.teamKey, aDoc.id);
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

describe("one session in two workspaces (X-Workspace)", () => {
  test("each request sees and writes only the workspace it names; one the person is not in is a 404", async () => {
    const db = await getDb();
    const [u] = await db.insert(schema.users).values({ email: `both-${RUN}@example.com`, name: "Both", passwordHash: "x" }).returning();
    const token = crypto.randomBytes(24).toString("base64url");
    await db.insert(schema.sessions).values({ id: sha256(token), userId: u.id, expiresAt: new Date(Date.now() + 864e5) });
    const slugs: string[] = [];
    for (const id of [A.workspaceId, B.workspaceId]) {
      await db.insert(schema.memberships).values({ userId: u.id, workspaceId: id, role: "owner" });
      slugs.push((await db.select({ slug: schema.workspaces.slug }).from(schema.workspaces).where(eq(schema.workspaces.id, id)))[0].slug);
    }
    const as = async (slug: string) => (await humanFromSession(token, slug))!.actor;
    const [a, b] = [await as(slugs[0]), await as(slugs[1])];
    assert.equal(a.workspaceId, A.workspaceId);
    assert.equal(b.workspaceId, B.workspaceId);
    for (const [actor, tag] of [[a, "in A"], [b, "in B"]] as const) {
      await createTeam(actor, { name: `Both ${tag}`, key: "BO" });
      await createIssue(actor, "BO", { title: `written ${tag}` });
    }
    assert.equal(((await runTool(a, "get_issue", { ref: "BO-1" })) as { issue: { title: string } }).issue.title, "written in A");
    assert.equal(((await runTool(b, "get_issue", { ref: "BO-1" })) as { issue: { title: string } }).issue.title, "written in B");
    const [other] = await db.insert(schema.workspaces).values({ name: `Stranger ${RUN}` }).returning();
    await assert.rejects(humanFromSession(token, other.slug), (e: unknown) => e instanceof ServiceError && e.code === "not_found");
  });
});

describe("team keys are per workspace (continued)", () => {
  test("B creating a team with A's key gets its own team, and A's is untouched", async () => {
    const before = await fingerprint(A);
    const p = await createTeam(B.owner, { name: "B's AA", key: "AA" });
    assert.equal(p.workspaceId, B.workspaceId);
    assert.notEqual(p.id, A.teamId);
    const board = (await runTool(B.owner, "list_issues", { team: "AA" })) as { team: { name: string } };
    assert.equal(board.team.name, "B's AA");
    assert.equal(await fingerprint(A), before);
  });
});

describe("cycles stay inside their workspace and team (WH-117)", () => {
  const refused = (e: unknown) => (e as { cause?: { code?: string } }).cause?.code === "23503";
  const notFound = (e: unknown) => e instanceof ServiceError && e.code === "not_found";

  test("workspace B cannot list, read, make, change or delete a cycle of A's team, and A's cycles are not changed", async () => {
    const a = await cycles.createCycle(A.owner, A.teamKey, { name: "A-SECRET cycle", goal: "A-SECRET goal" });
    const before = await fingerprint(A);
    // A's team by its id: a key means B's own team of that key in B's workspace (keys are per workspace, tested above).
    await assert.rejects(cycles.listCycles(B.owner, A.teamId), notFound);
    await assert.rejects(cycles.getCycle(B.owner, A.teamId, a.number), notFound);
    await assert.rejects(cycles.createCycle(B.owner, A.teamId, {}), notFound);
    await assert.rejects(cycles.updateCycle(B.owner, A.teamId, a.number, { goal: "defaced" }), notFound);
    await assert.rejects(cycles.deleteCycle(B.owner, A.teamId, a.number), notFound);
    assert.equal((await cycles.getCycle(A.owner, A.teamKey, a.number)).goal, "A-SECRET goal");
    assert.equal(await fingerprint(A), before);
  });

  test("B's list of its own cycles shows none of A's, even with the same number", async () => {
    const b = await cycles.createCycle(B.owner, B.teamKey, { name: "B's own" });
    const list = await cycles.listCycles(B.owner, B.teamKey);
    const all = [list.current, ...list.upcoming, ...list.past].filter(Boolean);
    assert.deepEqual(all.map((c) => c!.name), ["B's own"]);
    assert.equal(b.number, 1, "numbers are per team: B's first cycle is 1, as A's is");
  });

  test("an issue of B cannot join A's cycle: the service looks for the number in B's own team, and the database refuses the id", async () => {
    const db = await getDb();
    const aCycle = (await db.select().from(schema.cycles).where(eq(schema.cycles.teamId, A.teamId)))[0];
    const bIssue = await createIssue(B.owner, B.teamKey, { title: "B wants A's cycle" });
    await assert.rejects(updateIssue(B.owner, bIssue.ref, { cycle: 99 }), ServiceError);
    await assert.rejects(db.update(schema.issues).set({ cycleId: aCycle.id }).where(eq(schema.issues.id, bIssue.id)), refused);
    await assert.rejects(updateIssue(B.owner, A.issueRef, { cycle: 1 }), notFound);
    assert.equal((await getIssue(B.owner, bIssue.ref)).issue.cycle, null);
  });

  test("a cycle row cannot name a workspace other than its team's", async () => {
    const db = await getDb();
    await assert.rejects(
      db.insert(schema.cycles).values({ teamId: A.teamId, workspaceId: B.workspaceId, number: 77, startsAt: new Date(), endsAt: new Date(Date.now() + 86_400_000) }),
      refused,
    );
  });
});

describe("projects stay inside their workspace, and show other teams only as totals (WH-118)", () => {
  const refused = (e: unknown) => (e as { cause?: { code?: string }; code?: string }).cause?.code === "23503" || (e as { code?: string }).code === "23503";
  const notFound = (e: unknown) => e instanceof ServiceError && e.code === "not_found";
  let aProject: Awaited<ReturnType<typeof projects.createProject>>;

  test("workspace B cannot list, open, change, delete, add to or take from A's project, and A's project is not changed", async () => {
    aProject = await projects.createProject(A.owner, { name: "A-SECRET project", description: "A-SECRET description", leadTeam: A.teamId });
    await createIssue(A.owner, A.teamKey, { title: "A-SECRET in the project", projectId: aProject.id });
    const before = await fingerprint(A);
    assert.ok(!(await projects.listProjects(B.owner)).some((p) => p.id === aProject.id));
    assert.ok(!JSON.stringify(await projects.listProjects(B.owner)).includes("A-SECRET"));
    await assert.rejects(projects.getProject(B.owner, aProject.id), notFound);
    await assert.rejects(projects.updateProject(B.owner, aProject.id, { name: "defaced" }), notFound);
    await assert.rejects(projects.deleteProject(B.owner, aProject.id), notFound);
    await assert.rejects(projects.addProjectTeam(B.owner, aProject.id, B.teamKey), notFound);
    await assert.rejects(projects.removeProjectTeam(B.owner, aProject.id, A.teamKey), notFound);
    await assert.rejects(projects.createMilestone(B.owner, aProject.id, { name: "planted" }), notFound);
    assert.equal((await projects.getProject(A.owner, aProject.id)).name, "A-SECRET project");
    assert.equal(await fingerprint(A), before);
  });

  test("B cannot lead a project with A's team, or bring it in, and a project made by B has only B's teams", async () => {
    await assert.rejects(projects.createProject(B.owner, { name: "steal", leadTeam: A.teamId }), notFound);
    const bProject = await projects.createProject(B.owner, { name: "B's own", leadTeam: B.teamKey });
    await assert.rejects(projects.addProjectTeam(B.owner, bProject.id, A.teamId), notFound);
    assert.deepEqual((await projects.getProject(B.owner, bProject.id)).teams.map((t) => t.key), [B.teamKey]);
    assert.deepEqual((await projects.listProjects(B.owner)).map((p) => p.name), ["B's own"]);
  });

  test("an issue of B cannot be put in A's project, through the service or around it", async () => {
    const db = await getDb();
    const bIssue = await createIssue(B.owner, B.teamKey, { title: "B wants A's project" });
    await assert.rejects(updateIssue(B.owner, bIssue.ref, { projectId: aProject.id }), (e: unknown) => e instanceof ServiceError && e.code === "invalid" && /does not exist/.test(e.message));
    await assert.rejects(db.update(schema.issues).set({ projectId: aProject.id }).where(eq(schema.issues.id, bIssue.id)), refused);
    await assert.rejects(updateIssue(B.owner, A.issueRef, { projectId: aProject.id }), notFound);
    assert.equal((await getIssue(B.owner, bIssue.ref)).issue.projectId, null);
  });

  test("project rows cannot be made to name the other workspace", async () => {
    const db = await getDb();
    await assert.rejects(db.insert(schema.projectTeams).values({ projectId: aProject.id, teamId: B.teamId, workspaceId: A.workspaceId }), refused);
    await assert.rejects(db.insert(schema.projectTeams).values({ projectId: aProject.id, teamId: B.teamId, workspaceId: B.workspaceId }), refused);
    await assert.rejects(db.insert(schema.projectMilestones).values({ projectId: aProject.id, workspaceId: B.workspaceId, name: "x", position: 1 }), refused);
  });

  test("two workspaces, two teams in one of them: the member of one team sees the other only as totals, and never in the other workspace", async () => {
    // A's workspace gets a second team and a member of only it; the project spans both teams.
    const a2 = await createTeam(A.owner, { name: "A-SECOND team", key: `Z${RUN.slice(0, 3).replace(/[0-9a]/g, "q").toUpperCase()}` });
    const db = await getDb();
    const [u] = await db.insert(schema.users).values({ email: `a2-${RUN}@example.com`, name: "second-team member", passwordHash: "x" }).returning();
    await db.insert(schema.memberships).values({ userId: u.id, workspaceId: A.workspaceId, role: "member" });
    const { addTeamMember } = await import("../apps/api/src/modules/teams/teams.legacy");
    await addTeamMember(A.owner, a2.key, { userId: u.id, role: "editor" });
    await projects.addProjectTeam(A.owner, aProject.id, a2.key);
    await createIssue(A.owner, a2.key, { title: "SECOND-SECRET", projectId: aProject.id, status: "Done" });
    const second: Actor = { kind: "human", id: u.id, name: u.name, workspaceId: A.workspaceId };
    const seen = await projects.getProject(second, aProject.id);
    assert.deepEqual(seen.teams.map((t) => t.key), [a2.key]);
    assert.deepEqual(seen.others, { count: 1, total: 1, done: 0 }, "the other team has one open issue");
    const text = JSON.stringify(seen);
    assert.ok(!text.includes("A-SECRET in the project") && !text.includes(A.teamKey), "no title and no key of the team they are not on");
    assert.ok(!(await projects.listProjects(B.owner)).some((p) => p.id === aProject.id), "and B still sees none of it");
  });
});

describe("initiatives stay inside their workspace and show projects of other teams only as totals (WH-119)", () => {
  const notFound = (e: unknown) => e instanceof ServiceError && e.code === "not_found";
  const refused = (e: unknown) => ["23503", "23514"].includes((e as { cause?: { code?: string } }).cause?.code ?? "");
  let aInitiative: Awaited<ReturnType<typeof initiatives.createInitiative>>;
  let aProject: Awaited<ReturnType<typeof projects.createProject>>;
  before(async () => {
    aProject = await projects.createProject(A.owner, { name: "A-SECRET project", leadTeam: A.teamId });
    aInitiative = await initiatives.createInitiative(A.owner, { name: "A-SECRET initiative", description: "A-SECRET description" });
    await initiatives.linkProject(A.owner, aInitiative.id, aProject.id);
  });

  test("another workspace sees none of it and changes none of it, whoever asks", async () => {
    assert.ok(!JSON.stringify(await initiatives.listInitiatives(B.owner)).includes("A-SECRET"));
    await assert.rejects(initiatives.getInitiative(B.owner, aInitiative.id), notFound);
    await assert.rejects(initiatives.updateInitiative(B.owner, aInitiative.id, { name: "defaced" }), notFound);
    await assert.rejects(initiatives.deleteInitiative(B.owner, aInitiative.id), notFound);
    await assert.rejects(initiatives.linkProject(B.owner, aInitiative.id, aProject.id), notFound);
    await assert.rejects(initiatives.unlinkProject(B.owner, aInitiative.id, aProject.id), notFound);
    assert.equal((await initiatives.getInitiative(A.owner, aInitiative.id)).name, "A-SECRET initiative");
  });

  test("B cannot hang its initiative under A's, nor group A's project, and the database agrees", async () => {
    await assert.rejects(initiatives.createInitiative(B.owner, { name: "steal", parentId: aInitiative.id }), (e: unknown) => e instanceof ServiceError && e.code === "invalid");
    const mine = await initiatives.createInitiative(B.owner, { name: "B's own" });
    await assert.rejects(initiatives.linkProject(B.owner, mine.id, aProject.id), notFound);
    const db = await getDb();
    await assert.rejects(db.insert(schema.initiativeProjects).values({ initiativeId: mine.id, projectId: aProject.id, workspaceId: B.workspaceId }), refused);
    const unlinked = await projects.createProject(A.owner, { name: "A-SECRET second", leadTeam: A.teamId });
    await assert.rejects(db.insert(schema.initiativeProjects).values({ initiativeId: aInitiative.id, projectId: unlinked.id, workspaceId: B.workspaceId }), refused);
    await assert.rejects(db.update(schema.initiatives).set({ parentId: aInitiative.id }).where(eq(schema.initiatives.id, mine.id)), refused);
    assert.deepEqual((await initiatives.listInitiatives(B.owner)).map((i) => i.name), ["B's own"]);
  });
});

describe("the database refuses a row that points across workspaces (WH-113)", () => {
  // Even code that skips the service layer cannot put workspace B's row on workspace A's team, or the reverse.
  const refused = (e: unknown) => (e as { cause?: { code?: string } }).cause?.code === "23503";

  test("B's workspace id on A's team is refused, for a status, a node and a team member", async () => {
    const db = await getDb();
    const before = await fingerprint(A);
    await assert.rejects(db.insert(schema.statuses).values({ teamId: A.teamId, workspaceId: B.workspaceId, name: "planted", position: 99, role: "todo" }), refused);
    await assert.rejects(db.insert(schema.nodes).values({ teamId: A.teamId, workspaceId: B.workspaceId, layer: "system", kind: "service", name: "planted" }), refused);
    await assert.rejects(db.insert(schema.teamMembers).values({ teamId: A.teamId, workspaceId: B.workspaceId, userId: B.owner.id, role: "admin" }), refused);
    assert.equal(await fingerprint(A), before);
  });

  test("B's owner cannot be made a member of A's team under A's workspace either: they are not in it", async () => {
    const db = await getDb();
    await assert.rejects(db.insert(schema.teamMembers).values({ teamId: A.teamId, workspaceId: A.workspaceId, userId: B.owner.id, role: "admin" }), refused);
  });

  test("an issue of A cannot be assigned to someone from B, through the service or around it", async () => {
    const db = await getDb();
    await assert.rejects(updateIssue(A.owner, A.issueRef, { assigneeId: B.owner.id }), ServiceError);
    await assert.rejects(db.update(schema.issues).set({ assigneeId: B.owner.id }).where(eq(schema.issues.id, A.issueId)), refused);
  });
});

// ───────── guards: new entry points must be audited ─────────

/** Files that call getDb() directly, and how each one scopes its queries. A new file must be added here. */
const DB_FILE_AUDIT: Record<string, string> = {
  "apps/api/src/modules/images/images.ts": "profile pictures and the workspace image. Writes touch only the caller's own user row, or (owners and admins) the row of the workspace the session is working in; both ids come from the verified session, never from the request. Reads return a workspace's image only for the caller's own workspace, and a person's picture only when that person is a member of the caller's workspace (the join is on the session's workspace id); anything else is not_found (tested in images.test.ts)",
  "apps/api/src/modules/daemon/daemon.repository.ts": "the only file of the daemon module that queries (devices, device_pairings, device_tokens, device_messages, device_jobs, device_job_events, instance_keys, chat_threads, chat_messages); it decides nothing. The machine side reaches only its own device: a job by job id AND the token's device id (another device's job is not_found), messages by the token's device id (and each is signed for that device alone, tested in daemon.test.ts), a pairing by its secret device code, a token by the sha256 of its secret and only while live; a job moves between states by job id and the states it may come from, so two writers cannot both win; the sweep is time-based and only moves job states. The person's side selects a device by owner id alone (a device belongs to the person and serves every workspace they are in; another person's device is not_found), reads a job by job id AND the caller's workspace id (then through its issue's team in RunsService, tested in daemon.test.ts: a stranger in another workspace and a teammate without the device are refused), and unpairing cancels only that device's own jobs. Read-only joins reach another area's table because the machine side may not call other modules: the issue, team key and repository of a job's own issue and repository for its pull request. A chat thread is read by thread id AND owner id AND the caller's workspace id (another person's, even a teammate's, is not_found, tested in chat.test.ts), a chat message by message id AND the token's device id; the thread list joins the team key, device and repository names read only. The instance's signing key is the one row of instance_keys, no workspace data",
  "apps/api/src/modules/agents/agents.repository.ts": "the only file of the agents module that queries (workspace_agents, team_agents) and the one read of the workspace's own `settings` (the agents switch); it decides nothing. Every statement starts from the workspace id of the signed-in person or key; a team roster is read by a team id the service found through TeamAccessService.require (another workspace's team, or a team the person is not on, is not_found), a custom agent by slug AND workspace id, and a team agent is hidden from people who cannot open its team (tested in agents.test.ts)",
  "apps/api/src/modules/auth/user-directory.ts": "reads user ids only (no names, emails or workspaces), in pages by id, for a broadcast to everyone on the instance; it takes nothing from a request and no controller reaches it, only the internal broadcast service",
  "apps/api/src/modules/broadcasts/broadcasts.repository.ts": "the only file of the broadcasts module that queries; instance-level rows (no workspace) keyed by a sender's idempotency key, read and changed by id or key, never from a request: the module has no controller, only the internal broadcast service calls it. A broadcast holds no recipient data, and the inbox items it makes go through NotificationsRepository, one per person",
  "apps/api/src/modules/notifications/notifications.repository.ts": "the only file of the notifications module that queries; every read and change goes through ownedBy(Recipient): the row's recipient must be the signed-in person and its workspace the session's workspace (or null, an instance-level item that shows in all of theirs), so another person's id, or another workspace's, matches nothing and reads as not found. The recipient is built from the session, never the request. The inserts take rows the service already addressed, and the 30-day purge removes only rows already in the trash",
  "apps/api/src/modules/notifications/notifications.signal.ts": "sends the live signal 'inbox changed' with recipientUserId set, so a stream forwards it only to that person's own connections; it carries no item, title or body, and queries nothing itself",
  "apps/api/src/platform/database/database.ts": "hands out the client or the current transaction (`q`) and opens or joins a transaction; runs no queries itself",
  "apps/api/src/platform/events/events.service.ts": "writes the event log on the current transaction for an actor and a team its caller already resolved through the service layer (the same contract as emit); reads nothing",
  "apps/api/src/platform/database/database.service.ts": "opens the connection and runs the migrations at startup, then closes it on shutdown; runs no queries. No controller or guard may appear in this list",
  "apps/api/src/db/index.ts": "the connection itself",
  "apps/api/src/modules/auth/auth.repository.ts": "the only file of the auth module that queries (users, sessions, workspaces, memberships, invites, invite teams, API keys and their team scopes, the access audit log); it decides nothing, and every caller is a service that scopes its statements by the caller's own workspace id: members, keys, pending invites and the audit line are read and written only for the signed-in person's workspace, so a user or key id from another workspace matches nothing and reads as not found (tested). A session or key is found only by the sha256 of its secret and only while it is live; an invite only by the sha256 of its token and only while it is pending, and it is claimed by one guarded UPDATE inside the acceptance transaction, so two accepts cannot both win (tested). Join invites lock their workspace row for the seat check. Instance admin: the workspace list is metadata only (names, emails, counts, dates; tested), and suspending or restoring is for instance admins only (tested in workspaces-admin.test.ts)",
  "apps/api/src/modules/teams/teams.repository.ts": "the only file of the teams module that queries; it decides nothing, and every caller is a service that starts from TeamAccessService.require(actor, key, need) (the former requireTeam): not_found for a team of another workspace or one the person is not a member of, 403 below the needed role (ADR-23). Members: the workspace-wide views (all team names, the audit log) are for workspace owners and admins and every change checks the caller's role and keeps one admin (tested in team-access.test.ts). Lifecycle: every action runs inside a transaction that locks the workspace's teams, a parent must be one the person can open so the hierarchy grants no access, and children and candidates are filtered to teams the person can open (tested in team-lifecycle.test.ts). Statuses: admin to change anything, humans only, every statement scoped by the found team's id, and a status is looked up among that team's own statuses only, so another team's or workspace's id is a 404 (tested in statuses.test.ts)",
  "apps/api/src/platform/streams/stream-scope.ts": "the team stream resolves the team through requireTeam(actor); the dashboard stream is filtered to the teams the person is a member of, in the replay and for live events (tested)",
  "apps/api/src/modules/dashboard/dashboard.repository.ts": "the only file of the dashboard module that queries, and the one place a module reads other modules' tables (teams, statuses, issues, the event log, nodes, docs, keys, sessions, drafts, decisions, members, repositories, memberships, invites): the dashboard is the read model that looks across areas, and rebuilding its aggregates from service calls would be slow and pointless. Read-only, it decides nothing, and every call is by the caller's workspace id and the team ids the person can open (MetricsService: TeamAccessService.visibleTeamIds, or a team resolved through TeamAccessService.require), or by a team that ChecklistService resolved through TeamAccessService.require (tested)",
  "apps/api/src/modules/github/github.repository.ts": "the only file of the github module that queries; it decides nothing, and every caller is a service. Webhooks reach a repository only through its own workspace's link to the installation (targetsFor joins installation workspace = team workspace; tested with two workspaces sharing a GitHub repo id); connecting is owner-only and checks the installation belongs to the caller's workspace; repositories are found inside the team the caller opened through TeamAccessService.require(actor, key, need), so another workspace's repository is not_found (tested)",
  "apps/api/src/modules/docs/docs.repository.ts": "the only file of the docs module that queries; it decides nothing, and every caller is a service that starts from TeamAccessService.require(actor, key, need): a doc, a parent and a linked node are found inside the actor's team only, so another workspace's are not_found (tested in docs.test.ts and in this file's cross-workspace attacks); the members it lists are those of the signed-in person's own workspace, and an agent key's capabilities are read by the key's own id (tested)",
  "apps/api/src/lib/service-queue.ts": "every function resolves through requireTeam / resolveIssue (tested)",
  "apps/api/src/platform/streams/stream-open.ts": "live streams: human sessions only, scope from stream-scope.ts (requireTeam / the caller's own workspace id, tested in live-events.test.ts), capped per user",
  "apps/api/src/modules/map/map.repository.ts": "the only file of the map module that queries; it decides nothing, and every caller is a service that starts from TeamAccessService.require(actor, key, need) (the former requireTeam / resolveIssue): nodes, edges, flows, decisions, terms, drafts, work sessions, landed files and the docs the map flags are all read and written by the found team's id, a node or flow is looked up inside that team only, and a draft is resolved only when it belongs to the actor's team and is pending, so another workspace's are not_found and stay untouched (tested). Graph: nodes, edges, flows and the data layer (graph.service). Decisions: ADRs and glossary (decisions.service). Freshness: reported changes, landing and draft publishing (freshness.service). Sync: sessions, drafts and debt (sessions.service); every entry point resolves the team first (tested)",
  "apps/api/src/modules/map/sessions.service.ts": "hands the current handle (`this.db.q`) to pruneSessions(q, team.id) after ending a session of the team found through TeamAccessService.require(actor, key); every other statement goes through MapRepository, audited above (tested)",
  "apps/api/src/modules/issues/issues.repository.ts": "the only file of the issues service that queries issues, comments, labels and issue_nodes; it decides nothing, and every caller is IssuesService, which resolves through TeamAccessService.require(actor, key, need) or resolveIssue (the issue found inside the actor's workspace, then the actor's role on its team: another workspace's team or issue and one the person is not on are not_found). The board's map nodes and members are selected by that team's id; the issue_nodes row is written or removed only for an issue resolved with edit and a node resolved inside that issue's own team, so a node of another team or workspace is not_found (tested over HTTP with two workspaces)",
  "apps/api/src/modules/issues/cycles/cycles.repository.ts": "the only file of the cycles service that queries; every statement is scoped by the team id the service found through TeamAccessService.require(actor, key, need); a cycle is looked up by its number inside that team only, and an issue joins a cycle only through a (cycle_id, team_id) key, so another workspace's or team's cycle is a 404 and the database refuses the cross-team write (tested)",
  "apps/api/src/modules/issues/projects/projects.repository.ts": "the only file of the projects service that queries; workspace-level, so every statement starts from the signed-in person's workspace and a human actor: a project opens only through ProjectsService.openProject(), which needs the person on a team that takes part (a guest never is) and answers not_found otherwise; lists go through project_visibility; issue detail is read only for the viewer's own teams and every other team is counted, never named; an issue reaches a project only through its own team's project_teams row, which the database enforces (tested)",
  "apps/api/src/modules/issues/initiatives/initiatives.repository.ts": "the only file of the initiatives service that queries; workspace-level, so every statement starts from the signed-in person's workspace and a human actor who is not a guest (a guest and a stranger both get not_found): lists and reads take only that workspace's rows, a project is linked only through ProjectsService.openProject() (the person must be on a team that takes part), and what an initiative shows of a project follows project_visibility, so the rest are counted and totalled, never named, and no issue is ever listed; the database refuses a parent or a project of another workspace (tested)",
};

const walk = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]));

describe("new entry points must be audited", () => {
  test("every file that touches the database directly has an audit entry", () => {
    // The whole API: the service layer (src/lib) must stay covered, and its controllers and guards must not touch the database,
    // so none has an audit entry and any that does fails here.
    const files = walk("apps/api/src")
      .filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f))
      .filter((f) => /\bgetDb\(|\bthis\.db\.q\b/.test(fs.readFileSync(f, "utf8")))
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
  "PUT /api/app/me/avatar": "setAvatarAs(human): the caller's own user row, from the session; nothing in the request names whose picture it is",
  "DELETE /api/app/me/avatar": "setAvatarAs(human, null): the caller's own user row only",
  "PUT /api/app/workspace/image": "setWorkspaceImageAs(human): the session's workspace only; owners and admins (canManagePeople), others get forbidden",
  "DELETE /api/app/workspace/image": "setWorkspaceImageAs(human, null): the session's workspace only; owners and admins",
  "GET /api/app/images/:kind/:id": "readImageAs(human): a workspace image only when :id is the caller's own workspace; a person's picture only when they are a member of the caller's workspace; anything else is not_found",
  // The agent daemon (modules/daemon). /api/daemon is for devices: pairing and the token exchange are the way in and need no session;
  // everything else needs a device token, which names exactly one device, and reaches only that device's own jobs and messages.
  "POST /api/daemon/pair/start": "no workspace data: stores a pending pairing (the machine's public key and name) behind a random code; rate limited per address",
  "POST /api/daemon/pair/poll": "the daemon's secret device code: answers only that pairing's state, and once approved its own device id",
  "POST /api/daemon/token": "an assertion signed by the device's own key: answers a token for that one device; another key, a revoked device or a reused assertion is refused (tested)",
  "GET /api/daemon/stream": "the device token's own messages only (device_messages by device id); ends when the device is revoked (tested)",
  "POST /api/daemon/hello": "updates the token's own device; reconciles only that device's jobs",
  "POST /api/daemon/heartbeat": "updates the token's own device",
  "POST /api/daemon/jobs/:id/accept": "the job by id AND the token's device id; another device's job is not_found (tested)",
  "POST /api/daemon/jobs/:id/reject": "the job by id AND the token's device id",
  "POST /api/daemon/jobs/:id/events": "the job by id AND the token's device id",
  "POST /api/daemon/jobs/:id/finish": "the job by id AND the token's device id",
  "GET /api/app/devices": "the caller's own devices: owner id, whatever workspace is open",
  "PATCH /api/app/devices/:id": "a device of the caller's own (owner id); anyone else's is not_found (tested)",
  "DELETE /api/app/devices/:id": "a device of the caller's own (owner id)",
  "GET /api/app/devices/pair": "a pending pairing by its code; no workspace data; the machine as it described itself",
  "POST /api/app/devices/pair": "approving creates a device owned by the caller, in no workspace",
  "POST /api/app/devices/pair/deny": "a pending pairing by its code; changes only its state",
  "GET /api/app/issues/:ref/jobs": "resolveIssue(actor) first; the runs of that issue, the caller's own devices, the issue team's repositories",
  "GET /api/app/issues/:ref/jobs/branches": "resolveIssue(actor) first; a repository of the issue's own team",
  "POST /api/app/issues/:ref/jobs": "resolveIssue(actor, edit); a device of the caller's own; a repository of the issue's team; a continued run must be of the same issue (tested)",
  "GET /api/app/jobs/:id/events": "the job's workspace must be the caller's, and its issue must resolve for the caller (resolveIssue); otherwise not_found (tested)",
  "POST /api/app/jobs/:id/cancel": "as reading the job, and only its starter or the device's owner may cancel (tested)",
  "POST /api/app/jobs/:id/mark-lost": "as reading the job; only an unreachable run, and only by the device's owner or someone who can edit its issue (tested)",
  "POST /api/daemon/chat/:messageId/events": "the chat message by id AND the token's device id (the thread must be on that device); another device's message is not_found (tested)",
  "POST /api/daemon/chat/:messageId/finish": "the chat message by id AND the token's device id; another device's message is not_found, a final one is a 409 (tested)",
  "GET /api/app/chats": "the caller's own threads: owner id AND the session's workspace id; humans only",
  "GET /api/app/chats/options": "the caller's own devices, and the repositories of the named team resolved through the teams module (another workspace's team is a 404)",
  "POST /api/app/chats": "a device of the caller's own and online, a repository of the named team the caller can open; the thread is owned by the caller in their own workspace (tested)",
  "GET /api/app/chats/:id": "thread id AND owner id AND workspace id; another person's, even a teammate's, is not_found (tested)",
  "POST /api/app/chats/:id/messages": "as reading the thread; the owner's own device, one running answer at a time (409, tested)",
  "POST /api/app/chats/:id/cancel": "as reading the thread; only the owner's thread, signed to the thread's own device (tested)",
  "DELETE /api/app/chats/:id": "as reading the thread; only the owner's thread (tested)",
  "GET /api/app/agents": "the caller's own workspace: its agents and the catalog; a team agent is listed only when the caller can open its team (tested)",
  "GET /api/app/agents/guardrails": "static text, no workspace data; people only",
  "GET /api/app/agents/catalog/:slug/versions": "static catalog text, no workspace data; people only",
  "PUT /api/app/agents/catalog/:slug/pin": "workspace owners and admins only; the pin is stored on the caller's own workspace row (tested)",
  "POST /api/app/agents": "a workspace admin for a workspace-wide agent, or a workspace admin or team admin of a team opened through requireTeam for a team agent; the row gets the caller's workspace id (tested)",
  "PATCH /api/app/agents/:slug": "slug AND the caller's workspace id; a team agent of a team the caller cannot open is not_found; creator or workspace admin, the face also by an admin of a team it is on (tested)",
  "DELETE /api/app/agents/:slug": "as editing; the creator or a workspace admin (tested)",
  "GET /api/app/teams/:key/agents": "requireTeam(actor, key, read): only that team's roster, so another workspace's team is a 404; empty while agents are off (tested)",
  "POST /api/app/teams/:key/agents": "requireTeam(actor, key, read), then a workspace admin or that team's admin; the agent is looked up by slug in the caller's workspace, and a team agent only goes on its own team (tested)",
  "DELETE /api/app/teams/:key/agents/:slug": "as adding; only that team's roster row is removed (tested)",
  "GET /api/v1/team-agents": "actor from the API key or session (ActorGuard); the team is opened through requireTeam, so a key reaches only the teams it is scoped to and another workspace's team is a 404 (tested)",
  "PATCH /api/app/workspace/settings": "the session's own workspace; owners and admins only (tested)",
  "GET /api/health": "select 1; no data, no auth",
  "POST /mcp": "actor from the API key or session (ActorGuard); every tool runs through the service layer with that actor (tested over HTTP in the contract suite)",
  "GET /mcp": "405, nothing read",
  "DELETE /mcp": "405, nothing read",
  "GET /api/v1": "tool definitions only; no data",
  "POST /api/v1/:tool": "actor from the API key or session (ActorGuard); the service layer is workspace scoped (tested over HTTP)",
  "POST /api/webhooks/github": "signature over the raw body first; a delivery reaches a repository only through its own workspace's installation link (targetsFor joins installation workspace = team workspace; tested with two workspaces sharing a repository id and a forged row)",
  "GET /api/github/install": "a signed-in owner (HumanGuard) in the workspace named by ?workspace=, which the signed state carries to the callback; the team is resolved through requireTeam(actor), so another workspace's team is a 404",
  "GET /api/github/callback": "a signed-in owner; the signed state must name this person, this workspace and the cookie's nonce; GitHub must say this person administers the installation; a link is per workspace, so one installation can serve several (tested)",
  "GET /api/stream": "a person's session only; the scope is the caller's own workspace id (workspaceScope), never from the request, and is limited to the teams the person is a member of",
  "GET /api/teams/:key/stream": "a person's session only; the team is resolved through requireTeam(actor), another workspace's is a 404",
  "GET /api/app/auth/options": "whether sign-up is open; no data about any workspace, no auth",
  "POST /api/app/auth/login": "one account by email and password; rate limited per address and per account; starts that person's own session",
  "POST /api/app/auth/signup": "creates a new user and a new workspace they own; reads nothing of any workspace",
  "POST /api/app/auth/logout": "deletes the session named by the caller's own cookie",
  "GET /api/app/me": "the signed-in person from their session (SessionGuard); nothing taken from the request",
  "GET /api/app/teams": "listTeams(actor) for the signed-in person's workspace (SessionGuard); a workspaceId in the query or a header is ignored (tested)",
  "POST /api/app/teams": "createTeam(actor): the team is made in the actor's own workspace; the workspace is never taken from the request (tested)",
  "PUT /api/app/teams/order": "setTeamOrder(actor): writes only the caller's own team_members rows (user, workspace and team all matched); keys that are not teams the caller can open are ignored, so another workspace's team cannot be touched or learned about (tested in team-access.test.ts)",
  "PATCH /api/app/teams/:key": "updateTeam(actor): requireTeam(actor, key, admin), so another workspace's team and one the person is not in are 404, a non-admin member is 403, and agents are refused; only name and description change, never the key (tested in team-access.test.ts)",
  "GET /api/app/teams/parent-candidates": "parentCandidates(actor): only the teams the person can open, in the actor's workspace (tested)",
  "GET /api/app/teams/:key/parent-candidates": "parentCandidates(actor, key): the team through requireTeam(actor, key, admin); candidates are the teams the person can open, minus the team and its descendants (tested)",
  "GET /api/app/teams/:key/settings": "getTeamSettings(actor, key): the team through requireTeam(actor, key, read); a parent or child the person cannot open is not named, only counted (tested)",
  "PUT /api/app/teams/:key/parent": "setTeamParent(actor, key, parent): requireTeam(actor, key, admin); the new parent must be a team of the same workspace that the person can open, not the team itself or a descendant (tested)",
  "POST /api/app/teams/:key/retire": "retireTeam(actor, key): requireTeam(actor, key, admin), humans only; the last active team, a project lead and active child teams are refused inside a transaction that locks the workspace's teams (tested)",
  "POST /api/app/teams/:key/restore": "restoreTeam(actor, key): requireTeam(actor, key, admin), humans only (tested)",
  "DELETE /api/app/teams/:key": "deleteTeam(actor, key): requireTeam(actor, key, admin), humans only, and the typed key must match; the last active team, a project lead and child teams are refused (tested)",
  "DELETE /api/app/teams/:key/sessions/:sessionId": "removeSession(actor): the team is resolved through requireTeam(actor) and the session must belong to it, so another workspace's is a 404 (tested)",
  "POST /api/app/me/password": "changes the signed-in person's own password, after checking the current one; nothing is taken from the request but the two passwords",
  "GET /api/app/notifications": "the signed-in person's own inbox, archive or trash: the recipient is the session's person and workspace, nothing about whose inbox it is comes from the request; `teamId` only narrows it further (tested)",
  "GET /api/app/notifications/unread-count": "counts the signed-in person's own unread items in the session's workspace (and their instance-level ones)",
  "POST /api/app/notifications/read-all": "changes only the signed-in person's own items in the session's workspace",
  "POST /api/app/notifications/:id/read": "the item is matched by id and the session's person and workspace together, so another person's item is a 404 and unchanged (tested)",
  "POST /api/app/notifications/:id/archive": "matched by id and the session's person and workspace together; another person's item is a 404 (tested)",
  "POST /api/app/notifications/:id/unarchive": "matched by id and the session's person and workspace together; another person's item is a 404 (tested)",
  "DELETE /api/app/notifications/:id": "moves to the trash only an item matched by id and the session's person and workspace together; another person's is a 404 (tested)",
  "POST /api/app/notifications/:id/restore": "matched by id and the session's person and workspace together; another person's item is a 404 (tested)",
  "POST /api/app/workspace": "any signed-in person makes a new team workspace and becomes its owner; it reads nothing of any workspace and the only membership it makes is the caller's own, in the new one (turned off by the instance for non-admins)",
  "POST /api/app/workspace/transfer": "requestTransfer(human): owners only, in the session's workspace; the person offered must be a non-guest member of that same workspace (tested)",
  "DELETE /api/app/workspace/transfer": "cancelTransfer(human): owners only; clears the offer of the session's own workspace",
  "POST /api/app/workspace/transfer/accept": "acceptTransfer(human): inside a transaction that locks the session's workspace, only the person the offer names can accept (anyone else is a 404), and it moves ownership of that workspace only; audited",
  "POST /api/app/workspace/transfer/decline": "declineTransfer(human): only the person the offer names (anyone else is a 404); clears the offer of the session's own workspace",
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
  "GET /api/app/keys": "the keys of the caller's own workspace (where workspace_id is the session's workspace) and the printed commands; a key value is never returned (tested)",
  "POST /api/app/keys/mark-all-seen": "markAllSeen(actor): keys and teams of the actor's workspace only; another workspace's key id is a 404 (tested)",
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
  "GET /api/app/teams/:key/statuses": "listStatuses(actor, key): requireTeam(actor, key); only that team's statuses and counts, so another workspace's team is a 404 (tested)",
  "POST /api/app/teams/:key/statuses": "createStatus(actor, key): a human, requireTeam(actor, key, admin), the team's row locked; the status is made in that team only (tested)",
  "PUT /api/app/teams/:key/statuses/order": "reorderStatuses(actor, key): a human, requireTeam(actor, key, admin); the ids must be exactly that team's, so another team's id is refused (tested)",
  "PATCH /api/app/teams/:key/statuses/:id": "updateStatus(actor, key, id): a human, requireTeam(actor, key, admin); the status is looked up inside that team only, so another team's id is a 404 (tested)",
  "DELETE /api/app/teams/:key/statuses/:id": "deleteStatus(actor, key, id, moveTo): a human, requireTeam(actor, key, admin); the status and the one its issues move to are both looked up inside that team (tested)",
  "GET /api/app/teams/:key/board": "boardView(actor): the team is resolved through requireTeam(actor), so another workspace's is a 404; members are this workspace's memberships only (tested)",
  "POST /api/app/teams/:key/issues": "createIssue(actor): the team through requireTeam(actor) (another workspace's is a 404), the status resolved inside that team, the assignee must be a member of the actor's workspace (tested)",
  "GET /api/app/teams/:key/queue": "queueStatus(actor): the team through requireTeam(actor); the keys are this workspace's (tested)",
  "GET /api/app/issues/:ref": "getIssue(actor): resolveIssue joins the team and requires its workspace to be the actor's, so another workspace's issue is a 404 (tested, including two workspaces with the same key)",
  "PATCH /api/app/issues/:ref": "updateIssue(actor): resolveIssue is workspace scoped; a stale version is a 409 that returns the trimmed current issue and changes nothing; the assignee must be on the actor's workspace (tested)",
  "POST /api/app/issues/:ref/move": "moveIssue(actor): resolveIssue is workspace scoped and the status is resolved inside the issue's own team (tested)",
  "DELETE /api/app/issues/:ref": "deleteIssue(actor): resolveIssue is workspace scoped (tested)",
  "POST /api/app/issues/:ref/comments": "addComment(actor): resolveIssue is workspace scoped (tested)",
  "PUT /api/app/issues/:ref/nodes/:nodeId": "linkIssueNode(actor): the issue is workspace scoped and the node is resolved inside the issue's own team, so another workspace's node is a 404 (tested)",
  "DELETE /api/app/issues/:ref/nodes/:nodeId": "linkIssueNode(actor, unlink): same scoping as linking (tested)",
  "GET /api/app/teams/:key/graph": "graphView(actor): the team through requireTeam(actor) (another workspace's is a 404); every table is read by that team's id (tested)",
  "PUT /api/app/teams/:key/nodes": "upsertNode(actor): the team through requireTeam(actor); a node is found only inside that team, so another workspace's node id is a 404; a stale version is a 409 that changes nothing (tested)",
  "DELETE /api/app/teams/:key/nodes/:id": "deleteNode(actor): the node is resolved inside the actor's team, so another workspace's is a 404 (tested)",
  "POST /api/app/teams/:key/nodes/:id/fresh": "markFresh(actor): the node is resolved inside the actor's team (tested)",
  "PUT /api/app/teams/:key/layout": "saveLayout(actor): every update is by node id AND the actor's team id, so another workspace's node ids move nothing (tested)",
  "POST /api/app/teams/:key/edges": "upsertEdge(actor): both ends are resolved inside the actor's team, so a node of another workspace is a 404 (tested)",
  "DELETE /api/app/teams/:key/edges/:id": "deleteEdge(actor): deleted by edge id AND the actor's team id, so another workspace's edge is untouched (tested)",
  "PUT /api/app/teams/:key/flows": "upsertFlow(actor): the flow is matched inside the actor's team and its steps resolve nodes inside it; a stale version is a 409 (tested)",
  "DELETE /api/app/teams/:key/flows/:id": "deleteFlow(actor): matched inside the actor's team, so another workspace's flow is a 404 (tested)",
  "PUT /api/app/teams/:key/decisions": "upsertDecision(actor): numbers are per team, matched inside the actor's team; a stale version is a 409 (tested)",
  "PUT /api/app/teams/:key/terms/:term": "upsertTerm(actor): matched by name inside the actor's team (tested with the same word in two workspaces)",
  "DELETE /api/app/teams/:key/terms/:term": "deleteTerm(actor): matched inside the actor's team (tested)",
  "POST /api/app/teams/:key/drafts/:id/resolve": "resolveDraft(actor): the draft must belong to the actor's team and be pending, so another workspace's is a 404 and stays pending (tested)",
  "POST /api/app/teams/:key/ask": "askAs(actor): the team is resolved first (another workspace's is a 404 before anything is counted or called); the prompt is built from the actor's own team only; 20 questions per person per 10 minutes; the server's API key is in no answer (tested against a fake Claude)",
  "GET /api/app/teams/:key/activity": "activityView(actor): listEvents resolves the team through requireTeam(actor); events are by that team's id; data is cut down to what the page links with (tested)",
  "GET /api/app/teams/:key/docs": "docsIndex(human): listDocs and getGraph resolve the team through requireTeam(actor); members are those of the person's own workspace (tested)",
  "GET /api/app/teams/:key/docs/:ref": "getDoc(actor): the doc is resolved inside the actor's team (by id or slug), so another workspace's doc is a 404 (tested)",
  "POST /api/app/teams/:key/docs": "createDoc(actor): the team through requireTeam(actor); the parent is resolved inside it, so another workspace's doc cannot be a parent (tested)",
  "PATCH /api/app/teams/:key/docs/:ref": "updateDoc(actor): the doc is resolved inside the actor's team; a stale version is a 409 returning the trimmed current doc and changes nothing (tested)",
  "POST /api/app/teams/:key/docs/:ref/fresh": "markDocFresh(actor): resolved inside the actor's team (tested)",
  "GET /api/app/teams/:key/docs/:ref/anchor-suggestions": "suggestDocAnchors(actor): the doc and its linked nodes are read inside the actor's team (tested)",
  "POST /api/app/teams/:key/docs/:ref/move": "moveDoc(actor): doc and new parent are both resolved inside the actor's team; cycles are refused (tested)",
  "DELETE /api/app/teams/:key/docs/:ref": "deleteDoc(actor): resolved inside the actor's team (tested)",
  "PUT /api/app/teams/:key/docs/:ref/nodes/:nodeId": "linkDocNode(actor): the doc and the node are both resolved inside the actor's team, so another workspace's node is a 404 (tested)",
  "DELETE /api/app/teams/:key/docs/:ref/nodes/:nodeId": "linkDocNode(actor, unlink): same scoping as linking (tested)",
  "GET /api/app/teams/:key/cycles": "listCycles(actor, key): requireTeam(actor, key); only that team's cycles and counts (tested)",
  "POST /api/app/teams/:key/cycles": "createCycle(actor, key): requireTeam(actor, key, edit), the team's row locked, the cycle made in that team only (tested)",
  "GET /api/app/teams/:key/cycles/:number": "getCycle(actor, key, number): requireTeam(actor, key); the number is resolved inside that team, so another team's or workspace's cycle is a 404 (tested)",
  "PATCH /api/app/teams/:key/cycles/:number": "updateCycle(actor, key, number): requireTeam(actor, key, edit), the cycle resolved inside that team (tested)",
  "DELETE /api/app/teams/:key/cycles/:number": "deleteCycle(actor, key, number): requireTeam(actor, key, edit), the cycle resolved inside that team (tested)",
  "GET /api/app/initiatives": "listInitiatives(actor): the caller's workspace only, empty for a guest (tested)",
  "POST /api/app/initiatives": "createInitiative(actor): a human who is not a guest or a viewer; the parent must be in the caller's workspace and one they own or administer (tested)",
  "GET /api/app/initiatives/:id": "getInitiative(actor, id): the caller's workspace only; projects of the viewer's teams in full, the rest as totals (tested)",
  "PATCH /api/app/initiatives/:id": "updateInitiative(actor, id): the owner or a workspace admin; the tree is locked so no cycle or fourth level can form; checked against its version (tested)",
  "DELETE /api/app/initiatives/:id": "deleteInitiative(actor, id): the owner or a workspace admin; soft delete, children move up, projects untouched (tested)",
  "POST /api/app/initiatives/:id/projects": "linkProject(actor, id): the owner or a workspace admin, and a project the person sees through openProject() (tested)",
  "DELETE /api/app/initiatives/:id/projects/:projectId": "unlinkProject(actor, id, projectId): the owner or a workspace admin, and a project the person sees (tested)",
  "GET /api/app/projects": "listProjects(actor): through project_visibility (people on a team that takes part, never a guest) in the caller's workspace (tested)",
  "POST /api/app/projects": "createProject(actor): the lead team and each extra team through requireTeam(actor, key, edit), so only teams the person edits take part; made in the caller's own workspace (tested)",
  "GET /api/app/projects/:id": "getProject(actor, id): openProject needs the person on a team that takes part; issue detail only for their own teams, the others as totals (tested)",
  "PATCH /api/app/projects/:id": "updateProject(actor, id): openProject(edit), or admin to change the lead; the row is locked and checked against its version (tested)",
  "DELETE /api/app/projects/:id": "deleteProject(actor, id): openProject(admin); soft delete, its issues released (tested)",
  "POST /api/app/projects/:id/teams": "addProjectTeam(actor, id): openProject(edit) and requireTeam(actor, team, edit): nobody is pulled in (tested)",
  "DELETE /api/app/projects/:id/teams/:key": "removeProjectTeam(actor, id, key): the project's editors or an admin of that team; never the lead team; issues are released only on request (tested)",
  "POST /api/app/projects/:id/milestones": "createMilestone(actor, id): openProject(edit) (tested)",
  "PATCH /api/app/projects/:id/milestones/:milestoneId": "updateMilestone(actor, id, mid): openProject(edit); the milestone is looked up inside that project only (tested)",
  "DELETE /api/app/projects/:id/milestones/:milestoneId": "deleteMilestone(actor, id, mid): openProject(edit); looked up inside that project only (tested)",
  "GET /api/app/teams/:key/repositories": "listRepositories(actor): rows are selected by the team found through requireTeam(actor); the answer is a view without installation ids (tested)",
  "POST /api/app/teams/:key/repositories": "createRepository(actor): the team through requireTeam(actor); humans only (tested)",
  "GET /api/app/teams/:key/repositories/github": "githubStatus(human): installations are listed by the person's workspace id, and only for owners; repositories GitHub lists are asked per installation (tested against a fake GitHub)",
  "DELETE /api/app/teams/:key/repositories/github/:installationId": "unlinkInstallation(actor): owners only, deletes only the actor's workspace's link and clears the installation id on that workspace's repositories; other workspaces' links stay (tested with one installation linked by two workspaces)",
  "POST /api/app/teams/:key/repositories/github": "connectGithubRepository(actor): owners only, and the installation must be one of the actor's workspace (ADR-12); name and branch are read from GitHub (tested against a fake GitHub)",
  "PATCH /api/app/teams/:key/repositories/:id": "updateRepository(actor): the repository is resolved inside the actor's team (tested)",
  "POST /api/app/teams/:key/repositories/:id/retire": "retireRepository(actor): resolved inside the actor's team (tested)",
  "GET /api/app/teams/:key/repositories/:id/tree": "browseRepoTreeAs(actor): the repository is looked up in the actor's own team, so another workspace's repository id is a 404 and no tree is fetched (tested)",
  "GET /api/app/teams/:key/onboarding": "onboardingPage(actor): the team through TeamAccessService.require(actor); the commands carry no API key (tested)",
  "POST /api/app/teams/:key/onboarding/concept": "createConceptAs(actor): the team through TeamAccessService.require(actor, key, edit); the node is written to that team (tested)",
  "GET /api/app/dashboard/:widget": "MetricsService.*(actor): every query is by the actor's workspace id and limited to the teams the person is a member of; `?team=KEY` is resolved through requireTeam(actor, key), so another workspace's team, one the person is not in, a malformed value or a repeated parameter is a 404, and the snapshot is intersected with what they can open anyway; the Focus widget needs a team; an unknown widget is a 404 (tested)",
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

  test("every /api/app controller uses @AppEndpoints(), which requires a signed-in person; only the open sign-in and invite routes say @Public()", () => {
    const open = new Set([
      "GET /api/app/auth/options",
      "POST /api/app/auth/login",
      "POST /api/app/auth/signup",
      "POST /api/app/auth/logout",
      "POST /api/app/invites/peek",
      "POST /api/app/invites/accept",
    ]);
    const marked = new Set<string>();
    let checked = 0;
    for (const f of controllerFiles("apps/api/src")) {
      const src = fs.readFileSync(f, "utf8");
      const prefix = prefixOf(src);
      if (!prefix.startsWith("api/app")) continue;
      checked++;
      assert.match(src, /@AppEndpoints\(\)/, `${f} must use @AppEndpoints() for CSRF, the session and the error envelope`);
      assert.doesNotMatch(src, /@Public\(\)\s*\n\s*export class/, `${f}: a whole controller must not be public; mark the routes`);
      // A method's decorators all sit between the previous method's signature and its own.
      let from = 0;
      for (const sig of src.matchAll(/^ {2}(?:async )?\w+\(.*$/gm)) {
        const chunk = src.slice(from, sig.index! + sig[0].length);
        from = sig.index! + sig[0].length;
        for (const m of chunk.matchAll(/@(Get|Post|Put|Patch|Delete)\(\s*(?:"([^"]*)")?\s*\)/g)) {
          const route = `${m[1].toUpperCase()} /${[prefix, m[2] ?? ""].filter(Boolean).join("/")}`;
          if (/@Public\(\)/.test(chunk)) {
            marked.add(route);
            assert.ok(open.has(route), `${route} in ${f} is @Public() but is not one of the open routes listed here`);
          } else {
            assert.ok(!open.has(route), `${route} in ${f} is listed as open but is not marked @Public()`);
          }
        }
      }
    }
    assert.deepEqual([...marked].sort(), [...open].sort(), "every open route must be marked @Public()");
    assert.ok(checked >= 8, "no /api/app controllers found; the scan may be broken");
  });
});
