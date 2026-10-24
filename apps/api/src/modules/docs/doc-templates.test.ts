/**
 * Doc templates (WH-65): the five static templates, threading `template` through
 * createDoc, the list_doc_templates tool, and the action-item extraction logic that backs
 * the docs UI's "Create issue" affordance. Cross-workspace isolation for the new
 * createIssueFromActionItemAction lives in isolation.test.ts (list_doc_templates itself
 * is static/global, so it's registered there with no attacks to run).
 */
process.env.PGLITE_DIR = "memory://";
delete process.env.DATABASE_URL;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_AUTH_TOKEN;

import crypto from "node:crypto";
import { before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { getDb, schema } from "../../db";
import type { Actor } from "../../common/actor";
import { createTeam } from "../teams/teams";
import { createDoc } from "./docs";
import { runTool } from "../../lib/tools";
import { DOC_TEMPLATES, DOC_TEMPLATE_IDS, extractActionItems, getDocTemplate, listDocTemplates } from "@wheelhouse/shared/doc-templates";
import { testApp } from "../../test/app";
await testApp();

const RUN = crypto.randomBytes(3).toString("hex");
let human: Actor;
let teamKey: string;

before(async () => {
  const db = await getDb();
  const [workspace] = await db.insert(schema.workspaces).values({ name: `doc-templates workspace ${RUN}` }).returning();
  const [owner] = await db.insert(schema.users).values({ email: `doc-templates-owner-${RUN}@example.com`, name: "Owner", passwordHash: "x" }).returning();
  await db.insert(schema.memberships).values({ userId: owner.id, workspaceId: workspace.id, role: "owner" });
  human = { kind: "human", id: owner.id, name: "Owner", workspaceId: workspace.id };
  const team = await createTeam(human, { name: "Templates team", key: "TP" });
  teamKey = team.key;
});

describe("doc templates: definitions", () => {
  test("there are exactly five, with the expected ids", () => {
    assert.equal(DOC_TEMPLATES.length, 5);
    assert.deepEqual(
      [...DOC_TEMPLATE_IDS].sort(),
      ["decision-record", "meeting-notes", "onboarding", "runbook", "spec"].sort(),
    );
  });

  const expectedHeadings: Record<string, string[]> = {
    spec: ["Problem", "Users", "Goals", "Non-goals", "Approach", "Open questions", "Related issues"],
    "decision-record": ["Context", "Options considered", "Decision", "Consequences"],
    runbook: ["When to use this", "Steps", "How to verify", "How to roll back", "Owner"],
    "meeting-notes": ["Who", "Decisions", "Action items"],
    onboarding: ["What this team is", "How to run it", "Where things are", "Who to ask"],
  };

  for (const t of DOC_TEMPLATES) {
    test(`${t.id} has its expected sections`, () => {
      for (const heading of expectedHeadings[t.id]) {
        assert.match(t.body, new RegExp(`^##\\s*${heading}`, "m"), `expected a "## ${heading}" heading in ${t.id}`);
      }
    });
  }

  test("getDocTemplate looks up by id and returns undefined for unknown ids", () => {
    assert.equal(getDocTemplate("runbook")?.name, "Runbook");
    assert.equal(getDocTemplate("not-a-template"), undefined);
    assert.equal(getDocTemplate(undefined), undefined);
  });

  test("listDocTemplates returns exactly the five with id/name/description and no bodies", () => {
    const list = listDocTemplates();
    assert.equal(list.length, 5);
    for (const t of list) {
      assert.ok(t.id && t.name && t.description);
      assert.equal((t as { body?: string }).body, undefined);
    }
  });
});

describe("createDoc + template", () => {
  test("a `template` id seeds the body when no explicit body is given", async () => {
    const d = await createDoc(human, teamKey, { title: "Our runbook", template: "runbook" });
    assert.equal(d.body, getDocTemplate("runbook")!.body);
  });

  test("an explicit body overrides the template", async () => {
    const d = await createDoc(human, teamKey, { title: "Custom", template: "runbook", body: "# Just this" });
    assert.equal(d.body, "# Just this");
  });

  test("no template and no body creates an empty doc (unchanged behavior)", async () => {
    const d = await createDoc(human, teamKey, { title: "Blank" });
    assert.equal(d.body, "");
  });

  test("an unknown template id is ignored, leaving the doc blank", async () => {
    const d = await createDoc(human, teamKey, { title: "Bad template", template: "nonsense" });
    assert.equal(d.body, "");
  });
});

describe("tools: list_doc_templates", () => {
  test("returns exactly the five with id/name/description, no bodies", async () => {
    const result = (await runTool(human, "list_doc_templates", {})) as { id: string; name: string; description: string }[];
    assert.equal(result.length, 5);
    const ids = result.map((t) => t.id).sort();
    assert.deepEqual(ids, ["decision-record", "meeting-notes", "onboarding", "runbook", "spec"].sort());
    for (const t of result) assert.equal((t as { body?: string }).body, undefined);
  });
});

describe("tools: upsert_doc with template", () => {
  test("create path seeds body from `template` when no body is passed", async () => {
    const created = (await runTool(human, "upsert_doc", { project: teamKey, title: "Spec via tool", template: "spec" })) as { body: string };
    assert.equal(created.body, getDocTemplate("spec")!.body);
  });
});

describe("extractActionItems", () => {
  test("finds unchecked items under an 'Action items' heading", () => {
    const md = `# Meeting notes

## Action items
- [ ] Ship the thing
- [x] Already done, skip this one
- [ ] Tell the workspace
`;
    const items = extractActionItems(md);
    assert.deepEqual(items.map((i) => i.text), ["Ship the thing", "Tell the workspace"]);
  });

  test("ignores checklist items outside the Action items section", () => {
    const md = `## Decisions
- [ ] Not an action item, just a stray checkbox here

## Action items
- [ ] Real one
`;
    const items = extractActionItems(md);
    assert.deepEqual(items.map((i) => i.text), ["Real one"]);
  });

  test("stops the section at the next heading of equal or shallower depth", () => {
    const md = `## Action items
- [ ] One

## Next section
- [ ] Should not be picked up
`;
    const items = extractActionItems(md);
    assert.deepEqual(items.map((i) => i.text), ["One"]);
  });

  test("matches heading variants case-insensitively", () => {
    assert.equal(extractActionItems("## ACTION ITEM\n- [ ] x").length, 1);
    assert.equal(extractActionItems("## action items\n- [ ] x").length, 1);
  });

  test("returns nothing when there's no Action items section", () => {
    assert.deepEqual(extractActionItems("## Decisions\n- [ ] stray"), []);
  });
});
