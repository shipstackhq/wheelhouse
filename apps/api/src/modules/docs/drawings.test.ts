/** Drawings (WH-146): docs of kind "drawing": the kind filter, versioning, limits, and that docs and drawings stay apart. */
process.env.PGLITE_DIR = "memory://";
delete process.env.DATABASE_URL;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_AUTH_TOKEN;

import crypto from "node:crypto";
import { before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { getDb, schema } from "../../db";
import type { Actor } from "../../common/actor";
import { ServiceError } from "../../common/service-error";
import { listEvents } from "../../lib/service-queue";
import { createTeam } from "../teams/teams.legacy";
import { createDoc, deleteDoc, getDoc, getDrawing, listDocs, listDrawings, searchDocs, updateDoc } from "./docs.legacy";
import { DRAWING_BODY_MAX_BYTES } from "./docs.rules";
import { testApp } from "../../test/app";
await testApp();

const RUN = crypto.randomBytes(3).toString("hex");
let human: Actor;
let teamKey: string;

const scene = (n: number) => JSON.stringify({ type: "excalidraw", version: 2, elements: Array.from({ length: n }, (_, i) => ({ id: `e${i}`, type: "rectangle" })), appState: {}, files: {} });
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>';
const invalid = (e: unknown) => e instanceof ServiceError && e.code === "invalid";

before(async () => {
  const db = await getDb();
  const [workspace] = await db.insert(schema.workspaces).values({ name: `drawings workspace ${RUN}` }).returning();
  const [owner] = await db.insert(schema.users).values({ email: `drawings-owner-${RUN}@example.com`, name: "Drawings owner", passwordHash: "x" }).returning();
  await db.insert(schema.memberships).values({ userId: owner.id, workspaceId: workspace.id, role: "owner" });
  human = { kind: "human", id: owner.id, name: "Drawings owner", workspaceId: workspace.id };
  teamKey = (await createTeam(human, { name: "Drawings team", key: "DR" })).key;
});

describe("drawings", () => {
  test("create, read, update, delete; an empty body is an empty scene", async () => {
    const d = await createDoc(human, teamKey, { title: "Architecture", kind: "drawing" });
    assert.equal(d.kind, "drawing");
    assert.equal(d.version, 1);
    assert.equal(JSON.parse(d.body).type, "excalidraw");

    const u = await updateDoc(human, teamKey, d.id, { kind: "drawing", body: scene(2), thumbnail: svg });
    assert.equal(u.version, 2);
    assert.equal(u.thumbnail, svg);
    const read = await getDrawing(human, teamKey, d.slug);
    assert.equal(JSON.parse(read.body).elements.length, 2);

    await deleteDoc(human, teamKey, d.id, "drawing");
    await assert.rejects(getDrawing(human, teamKey, d.id), (e: unknown) => e instanceof ServiceError && e.code === "not_found");
    const types = (await listEvents(human, teamKey, { limit: 10 })).map((e) => e.type);
    assert.ok(types.includes("doc.created") && types.includes("doc.updated") && types.includes("doc.deleted"));
  });

  test("a stale expected_version is refused and nothing is overwritten", async () => {
    const d = await createDoc(human, teamKey, { title: "Locked", kind: "drawing", body: scene(1) });
    await updateDoc(human, teamKey, d.id, { kind: "drawing", body: scene(2) }, 1);
    await assert.rejects(
      updateDoc(human, teamKey, d.id, { kind: "drawing", body: scene(3) }, 1),
      (e: unknown) => e instanceof ServiceError && e.code === "conflict",
    );
    assert.equal(JSON.parse((await getDrawing(human, teamKey, d.id)).body).elements.length, 2);
  });

  test("the kind filter: drawings are not in the docs tree, search or doc routes; docs are not in the drawings list", async () => {
    const doc = await createDoc(human, teamKey, { title: "Plain doc", body: "mermaid zebra" });
    const drawing = await createDoc(human, teamKey, { title: "Whiteboard", kind: "drawing", body: scene(1), thumbnail: svg });
    assert.ok(!(await listDocs(human, teamKey)).some((x) => x.id === drawing.id));
    assert.ok((await listDocs(human, teamKey)).some((x) => x.id === doc.id));
    const drawings = await listDrawings(human, teamKey);
    assert.ok(drawings.some((x) => x.id === drawing.id));
    assert.ok(!drawings.some((x) => x.id === doc.id));
    assert.equal(drawings.find((x) => x.id === drawing.id)?.thumbnail, svg);
    assert.ok(!("body" in drawings[0]));
    // search matches the drawing's JSON text only if it were indexed
    assert.equal((await searchDocs(human, teamKey, "rectangle")).results.length, 0);
    await assert.rejects(getDoc(human, teamKey, drawing.id), (e: unknown) => e instanceof ServiceError && e.code === "not_found");
    await assert.rejects(getDrawing(human, teamKey, doc.id), (e: unknown) => e instanceof ServiceError && e.code === "not_found");
    await assert.rejects(createDoc(human, teamKey, { title: "Under a drawing", parent: drawing.id }), (e: unknown) => e instanceof ServiceError && e.code === "not_found");
  });

  test("limits and shape: JSON object body, 2 MB, SVG thumbnail, markdown has none", async () => {
    await assert.rejects(createDoc(human, teamKey, { title: "Bad", kind: "drawing", body: "not json" }), invalid);
    await assert.rejects(createDoc(human, teamKey, { title: "Bad", kind: "drawing", body: "[]" }), invalid);
    const big = JSON.stringify({ files: { a: "x".repeat(DRAWING_BODY_MAX_BYTES) } });
    await assert.rejects(createDoc(human, teamKey, { title: "Big", kind: "drawing", body: big }), invalid);
    // a drawing may hold more than a markdown doc may
    const ok = JSON.stringify({ files: { a: "x".repeat(300_000) } });
    assert.equal((await createDoc(human, teamKey, { title: "Image heavy", kind: "drawing", body: ok })).version, 1);
    await assert.rejects(createDoc(human, teamKey, { title: "Bad thumb", kind: "drawing", thumbnail: "<script>alert(1)</script>" }), invalid);
    await assert.rejects(createDoc(human, teamKey, { title: "Md thumb", thumbnail: svg }), invalid);
  });
});
