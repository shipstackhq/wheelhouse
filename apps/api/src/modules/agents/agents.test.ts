/**
 * Agents against a real database: who may do what (workspace admin, team admin, creator, member, viewer), the workspace switch, pins and
 * the plugin's subagent files, the catalog's immutable faces, custom agents, invalid profiles, and what other teams and workspaces see.
 * Runs on an in-memory PGlite (`pnpm test`), or a real Postgres with TEST_DATABASE_URL.
 */
if (process.env.TEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
} else {
  process.env.PGLITE_DIR = "memory://";
  delete process.env.DATABASE_URL;
}

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { CATALOG } from "@wheelhouse/shared/agents/catalog/index";
import { toSubagentFile } from "@wheelhouse/shared/agents/render";
import type { AgentProfile } from "@wheelhouse/shared/agents/schema";
import { getDb, schema } from "../../db";
import type { Actor } from "../../common/actor";
import { ServiceError } from "../../common/service-error";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { testApp } from "../../test/app";
import { WorkspacesService } from "../auth/workspaces/workspaces.service";
import { addTeamMember, createTeam } from "../teams/teams.legacy";
import { AgentsService } from "./agents.service";
import { createAgentDto, updateAgentDto } from "./dto/agents.dto";
const app = await testApp();

const agents = app.get(AgentsService);
let db: Awaited<ReturnType<typeof getDb>>;
let wsId: string;
let owner: Actor; // workspace owner, admin of SA and SB
let wsAdmin: Actor; // workspace admin, an editor on SA only
let teamAdmin: Actor; // workspace member, admin of SA only
let editor: Actor; // workspace member, editor on SA
let viewer: Actor; // workspace viewer, on SA
let sbOnly: Actor; // workspace member, editor on SB only
let other: Actor; // owner of another workspace that also has a team SA
let keySA: Actor; // an agent key scoped to SA
const code = (c: ServiceError["code"]) => (e: unknown) => e instanceof ServiceError && e.code === c;

const profile = (slug: string, over: Partial<AgentProfile> = {}): AgentProfile => ({ ...structuredClone(CATALOG.backend[0]), slug, name: "Test", role: "Tester", ...over });

before(async () => {
  db = await getDb();
  const [w] = await db.insert(schema.workspaces).values({ name: "Agents workspace" }).returning();
  const [w2] = await db.insert(schema.workspaces).values({ name: "Other workspace" }).returning();
  wsId = w.id;
  const mk = async (name: string, ws: { id: string }, role: "owner" | "admin" | "member" | "viewer"): Promise<Actor> => {
    const [u] = await db.insert(schema.users).values({ email: `${name}-${Math.random().toString(16).slice(2, 8)}@example.com`, name, passwordHash: "x" }).returning();
    await db.insert(schema.memberships).values({ userId: u.id, workspaceId: ws.id, role });
    return { kind: "human", id: u.id, name, workspaceId: ws.id };
  };
  owner = await mk("owner", w, "owner");
  wsAdmin = await mk("wsadmin", w, "admin");
  teamAdmin = await mk("teamadmin", w, "member");
  editor = await mk("editor", w, "member");
  viewer = await mk("viewer", w, "viewer");
  sbOnly = await mk("sbonly", w, "member");
  other = await mk("other", w2, "owner");
  await createTeam(owner, { name: "Alpha", key: "SA" });
  await createTeam(owner, { name: "Beta", key: "SB" });
  await createTeam(other, { name: "Alpha too", key: "SA" });
  await addTeamMember(owner, "SA", { userId: wsAdmin.id, role: "editor" });
  await addTeamMember(owner, "SA", { userId: teamAdmin.id, role: "admin" });
  await addTeamMember(owner, "SA", { userId: editor.id, role: "editor" });
  await addTeamMember(owner, "SA", { userId: viewer.id, role: "viewer" });
  await addTeamMember(owner, "SB", { userId: sbOnly.id, role: "editor" });
  const [k] = await db.insert(schema.apiKeys).values({ workspaceId: w.id, name: "worker", prefix: "wh_", keyHash: "worker-agents" }).returning();
  const [sa] = await db.select().from(schema.teams).where(eq(schema.teams.workspaceId, w.id)).then((r) => r.filter((t) => t.key === "SA"));
  await db.insert(schema.apiKeyTeams).values({ apiKeyId: k.id, teamId: sa.id, workspaceId: w.id });
  keySA = { kind: "agent", id: k.id, name: "worker", workspaceId: w.id };
});

describe("the catalog and the switch", () => {
  test("every member reads the catalog, the guardrails and the versions", async () => {
    for (const who of [owner, editor, viewer]) {
      const l = await agents.list(who);
      assert.equal(l.enabled, true);
      assert.deepEqual(l.catalog.map((a) => a.slug).sort(), Object.keys(CATALOG).sort());
      assert.deepEqual([l.catalog[0].latestVersion, l.catalog[0].pinnedVersion, l.catalog[0].version], [1, null, 1]);
    }
    assert.match((await agents.guardrails(viewer)).text, /guardrails/i);
    assert.deepEqual((await agents.versions(viewer, "backend")).map((v) => v.version), [1]);
    await assert.rejects(agents.versions(viewer, "nope"), code("not_found"));
  });

  test("an agent key is not a teammate: it cannot manage agents", async () => {
    await assert.rejects(agents.list(keySA), code("forbidden"));
    await assert.rejects(agents.create(keySA, { profile: profile("by-key") }), code("forbidden"));
  });

  test("switched off, everything is hidden or empty and nothing can be changed; the data is kept", async () => {
    await agents.addToRoster(owner, "SA", "frontend");
    const set = (on: boolean) => db.update(schema.workspaces).set({ settings: { agentsEnabled: on } }).where(eq(schema.workspaces.id, wsId));
    await set(false);
    try {
      assert.deepEqual(await agents.list(owner), { enabled: false, catalog: [], workspace: [] });
      assert.deepEqual(await agents.roster(owner, "SA"), { agents: [] });
      assert.deepEqual(await agents.subagentFiles(keySA, "SA"), { files: [] });
      await assert.rejects(agents.guardrails(owner), code("not_found"));
      await assert.rejects(agents.create(owner, { profile: profile("off") }), code("not_found"));
      await assert.rejects(agents.pin(owner, "backend", null), code("not_found"));
      await assert.rejects(agents.addToRoster(owner, "SA", "backend"), code("not_found"));
    } finally {
      await set(true);
    }
    assert.deepEqual((await agents.roster(owner, "SA")).agents.map((a) => a.slug), ["frontend"], "the roster came back");
    await agents.removeFromRoster(owner, "SA", "frontend");
  });

  test("the workspace setting is for owners and admins", async () => {
    const workspaces = app.get(WorkspacesService);
    const human = (a: Actor, role: string) => ({ workspace: { id: wsId }, membership: { role }, user: { id: a.id }, actor: a }) as never;
    await assert.rejects(workspaces.updateSettingsAs(human(editor, "member"), { agentsEnabled: false }), code("forbidden"));
    assert.equal((await workspaces.updateSettingsAs(human(wsAdmin, "admin"), { agentsEnabled: true })).agentsEnabled, true);
  });
});

describe("pins and the plugin's files", () => {
  // The catalog has one version of each agent today; give backend a second one for these tests.
  const v2 = { ...CATALOG.backend[0], instructions: "You are Bram, version two." };
  before(() => void CATALOG.backend.push(v2));
  after(() => void CATALOG.backend.pop());

  test("only a workspace admin pins; a version that does not exist is refused with its field", async () => {
    for (const who of [teamAdmin, editor, viewer]) await assert.rejects(agents.pin(who, "backend", 1), code("forbidden"));
    await assert.rejects(agents.pin(owner, "backend", 3), (e) => e instanceof ServiceError && e.code === "invalid" && !!(e.details as { fields: object }).fields);
    await assert.rejects(agents.pin(owner, "nope", 1), code("not_found"));
  });

  test("the roster follows the latest until a version is pinned, and the v1 files render the pinned text; unpinning follows again", async () => {
    await agents.addToRoster(teamAdmin, "SA", "backend");
    const files = async () => (await agents.subagentFiles(keySA, "SA")).files;
    assert.deepEqual(await files(), [{ name: "wh-backend.md", content: toSubagentFile(v2) }]);
    assert.equal((await agents.pin(wsAdmin, "backend", 1)).pinnedVersion, 1);
    assert.deepEqual(await files(), [{ name: "wh-backend.md", content: toSubagentFile(CATALOG.backend[0]) }]);
    assert.equal((await agents.roster(editor, "SA")).agents[0].version, 1);
    assert.equal((await agents.pin(owner, "backend", null)).pinnedVersion, null);
    assert.equal((await files())[0].content, toSubagentFile(v2));
    await agents.removeFromRoster(owner, "SA", "backend");
  });
});

describe("a catalog agent's face and profile are Wheelhouse's", () => {
  test("nobody can change them, not even an owner", async () => {
    await assert.rejects(agents.update(owner, "backend", { avatar: { style: "lorelei", seed: "x" } }), code("invalid"));
    await assert.rejects(agents.update(owner, "backend", { profile: profile("backend") }), code("invalid"));
    await assert.rejects(agents.remove(owner, "backend"), code("invalid"));
    await assert.rejects(agents.create(owner, { profile: profile("backend") }), code("conflict"));
  });
});

describe("custom agents", () => {
  test("a workspace-wide agent is made by a workspace admin only", async () => {
    for (const who of [teamAdmin, editor, viewer]) await assert.rejects(agents.create(who, { profile: profile("wide") }), code("forbidden"));
    const made = await agents.create(wsAdmin, { profile: profile("wide") });
    assert.deepEqual([made.source, made.teamKey, made.can], ["custom", null, { edit: true, face: true }]);
    await assert.rejects(agents.create(owner, { profile: profile("wide") }), code("conflict"));
  });

  test("a team agent is made by that team's admin or a workspace admin, goes on that team's roster and nowhere else", async () => {
    await assert.rejects(agents.create(editor, { profile: profile("mine"), teamKey: "SA" }), code("forbidden"));
    await assert.rejects(agents.create(teamAdmin, { profile: profile("mine"), teamKey: "SB" }), code("not_found"));
    const made = await agents.create(teamAdmin, { profile: profile("mine"), teamKey: "SA" });
    assert.equal(made.teamKey, "SA");
    assert.deepEqual((await agents.roster(viewer, "SA")).agents.map((a) => a.slug), ["mine"]);
    await assert.rejects(agents.addToRoster(owner, "SB", "mine"), code("invalid"));
    await assert.rejects(agents.addToRoster(owner, "SA", "mine"), code("conflict"));
    assert.ok((await agents.list(editor)).workspace.some((a) => a.slug === "mine"));
    assert.ok(!(await agents.list(sbOnly)).workspace.some((a) => a.slug === "mine"), "another team's agent is not listed");
    await assert.rejects(agents.update(sbOnly, "mine", { avatar: { style: "lorelei", seed: "x" } }), code("not_found"));
  });

  test("the roster: members read; a workspace admin or the team's admin changes it; the activity says who was added", async () => {
    await assert.rejects(agents.addToRoster(editor, "SA", "reviewer"), code("forbidden"));
    await assert.rejects(agents.addToRoster(viewer, "SA", "reviewer"), code("forbidden"));
    await assert.rejects(agents.addToRoster(sbOnly, "SA", "reviewer"), code("not_found"));
    await assert.rejects(agents.addToRoster(owner, "SA", "nobody"), code("not_found"));
    await agents.addToRoster(teamAdmin, "SA", "reviewer");
    await agents.addToRoster(wsAdmin, "SA", "wide");
    await assert.rejects(agents.addToRoster(owner, "SA", "reviewer"), code("conflict"));
    const [ev] = await db.select().from(schema.events).where(eq(schema.events.type, "team.agent_added"));
    assert.match(ev.summary, /^added \w+ \(.+\) to the team$/);
    await assert.rejects(agents.removeFromRoster(editor, "SA", "reviewer"), code("forbidden"));
    await agents.removeFromRoster(teamAdmin, "SA", "reviewer");
    await assert.rejects(agents.removeFromRoster(owner, "SA", "reviewer"), code("not_found"));
  });

  test("edit and delete: the creator or a workspace admin; the face also by an admin of a team it is on; the slug never changes", async () => {
    await assert.rejects(agents.update(editor, "mine", { profile: profile("mine", { summary: "x" }) }), code("forbidden"));
    const edited = await agents.update(teamAdmin, "mine", { profile: profile("mine", { summary: "Edited." }) });
    assert.deepEqual([edited.summary, edited.version], ["Edited.", 2]);
    await assert.rejects(agents.update(teamAdmin, "mine", { profile: profile("renamed") }), code("invalid"));
    assert.equal((await agents.update(wsAdmin, "mine", { profile: profile("mine", { summary: "Admin." }) })).summary, "Admin.");
    // "wide" is wsAdmin's and on SA: SA's admin may change its face but not its profile; an editor neither
    const face = { style: "lorelei" as const, seed: "new-face" };
    assert.deepEqual((await agents.update(teamAdmin, "wide", { avatar: face })).avatar, face);
    await assert.rejects(agents.update(teamAdmin, "wide", { profile: profile("wide", { summary: "x" }) }), code("forbidden"));
    await assert.rejects(agents.update(editor, "wide", { avatar: face }), code("forbidden"));
    await assert.rejects(agents.remove(editor, "wide"), code("forbidden"));
    await assert.rejects(agents.remove(teamAdmin, "wide"), code("forbidden"));
    assert.deepEqual(await agents.remove(wsAdmin, "wide"), { ok: true });
    assert.ok(!(await agents.roster(owner, "SA")).agents.some((a) => a.slug === "wide"), "deleting takes it off the roster");
    await agents.remove(teamAdmin, "mine");
    await assert.rejects(agents.remove(owner, "mine"), code("not_found"));
  });
});

describe("invalid profiles are refused per field", () => {
  const fields = (input: unknown) => {
    try {
      new ZodValidationPipe(createAgentDto).transform(input);
    } catch (e) {
      return (e as { details: { fields: Record<string, string> } }).details.fields;
    }
    assert.fail("accepted");
  };

  test("each broken field is named", () => {
    const f = fields({ profile: profile("Bad Slug", { name: "x", summary: "", color: "teal" as never }) });
    for (const k of ["profile.slug", "profile.name", "profile.summary", "profile.color"]) assert.ok(k in f, `${k} in ${Object.keys(f)}`);
    assert.ok("profile" in fields({}));
    assert.ok("profile.tools" in fields({ profile: profile("ok-slug", { kind: "advisor", toolProfile: "edit" }) }), "an advisor with edit tools");
  });

  test("a face update is `profile` or `avatar`, not both and not neither", () => {
    const pipe = new ZodValidationPipe(updateAgentDto);
    assert.throws(() => pipe.transform({}), code("invalid"));
    assert.throws(() => pipe.transform({ profile: profile("x"), avatar: { style: "lorelei", seed: "a" } }), code("invalid"));
    assert.throws(() => pipe.transform({ avatar: { style: "micah", seed: "a" } }), code("invalid"));
    assert.deepEqual(pipe.transform({ avatar: { style: "lorelei", seed: "a" } }).avatar, { style: "lorelei", seed: "a" });
  });
});

describe("isolation", () => {
  test("another workspace sees none of this workspace's agents, pins or rosters, and cannot reach them by slug", async () => {
    await agents.create(owner, { profile: profile("secret") });
    await agents.pin(owner, "reviewer", 1);
    const l = await agents.list(other);
    assert.deepEqual(l.workspace, []);
    assert.ok(l.catalog.every((a) => a.pinnedVersion === null));
    await assert.rejects(agents.update(other, "secret", { avatar: { style: "lorelei", seed: "x" } }), code("not_found"));
    await assert.rejects(agents.remove(other, "secret"), code("not_found"));
    await assert.rejects(agents.addToRoster(other, "SA", "secret"), code("not_found"));
    await agents.addToRoster(owner, "SA", "secret");
    assert.deepEqual((await agents.roster(other, "SA")).agents, [], "its own SA, not ours");
    assert.deepEqual((await agents.subagentFiles(other, "SA")).files, []);
    // the same slug is free in the other workspace
    assert.equal((await agents.create(other, { profile: profile("secret") })).slug, "secret");
  });

  test("the plugin route: a key reads only the teams it is scoped to, and a stranger's team does not exist", async () => {
    assert.deepEqual((await agents.subagentFiles(keySA, "SA")).files.map((f) => f.name), ["wh-secret.md"]);
    await assert.rejects(agents.subagentFiles(keySA, "SB"), code("not_found"));
    await assert.rejects(agents.subagentFiles(keySA, "NOPE"), code("not_found"));
  });
});
