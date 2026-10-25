import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { CATALOG } from ".";

// Hash of each published version, oldest first. Never edit an entry: add a version to the agent's file and append its hash.
const PUBLISHED: Record<string, string[]> = {
  backend: ["d27e20e0611661a8"],
  frontend: ["88dc2dcddf33ac69"],
  fullstack: ["7a5df8717c33123f"],
  database: ["d53d24e78859ba1a"],
  reviewer: ["078777be43e15838"],
  architect: ["baf2dd9b9180c777"],
};

const hash = (p: unknown) => createHash("sha256").update(JSON.stringify(p)).digest("hex").slice(0, 16);

test("published catalog versions are unchanged", () => {
  assert.deepEqual(Object.keys(CATALOG).sort(), Object.keys(PUBLISHED).sort());
  for (const [slug, hashes] of Object.entries(PUBLISHED)) {
    const versions = CATALOG[slug];
    assert.ok(versions.length >= hashes.length, `${slug}: a published version was removed`);
    hashes.forEach((h, i) => assert.equal(hash(versions[i]), h, `${slug} v${i + 1} was edited; add a new version instead`));
  }
});
