import { test } from "node:test";
import assert from "node:assert/strict";
import { anchorScore, parseAnchor } from "./freshness";

test("a bare anchor has no repo qualifier", () => {
  assert.deepEqual(parseAnchor("src/db/**"), { repo: null, pattern: "src/db/**" });
  assert.deepEqual(parseAnchor("drizzle/**"), { repo: null, pattern: "drizzle/**" });
  assert.deepEqual(parseAnchor("src/lib/service.ts"), { repo: null, pattern: "src/lib/service.ts" });
});

test("a `repo:` prefix is parsed as a qualifier", () => {
  assert.deepEqual(parseAnchor("backend:src/**"), { repo: "backend", pattern: "src/**" });
  assert.deepEqual(parseAnchor("repo:**"), { repo: "repo", pattern: "**" });
  assert.deepEqual(parseAnchor("Backend:src/db/schema.ts"), { repo: "backend", pattern: "src/db/schema.ts" }, "qualifier is case-insensitive");
});

test("a colon that isn't a qualifier (glob chars or a slash before it) is left alone", () => {
  // Anchors already support "#name" suffixes (handled elsewhere); a colon preceded by a glob char or
  // slash is part of the pattern, not a qualifier, so it is never misparsed as one.
  assert.deepEqual(parseAnchor("src/db/**:weird"), { repo: null, pattern: "src/db/**:weird" });
  assert.deepEqual(parseAnchor("src/a:b"), { repo: null, pattern: "src/a:b" });
});

test("an unqualified anchor matches a file from any repo, including when the repo is unknown", () => {
  assert.ok(anchorScore("src/db/**", "src/db/schema.ts") > 0);
  assert.ok(anchorScore("src/db/**", "src/db/schema.ts", "frontend") > 0);
  assert.ok(anchorScore("src/db/**", "src/db/schema.ts", null) > 0);
  assert.ok(anchorScore("src/db/**", "src/db/schema.ts", undefined) > 0);
});

test("a qualified anchor only matches files reported under that repo", () => {
  assert.ok(anchorScore("backend:src/**", "src/index.ts", "backend") > 0);
  assert.equal(anchorScore("backend:src/**", "src/index.ts", "frontend"), 0, "same path, different repo: no match");
  assert.equal(anchorScore("backend:src/**", "src/index.ts", null), 0, "qualified anchor needs a known repo");
  assert.equal(anchorScore("backend:src/**", "src/index.ts"), 0, "qualified anchor needs a known repo (fileRepo omitted)");
});

test("the repo-qualifier match is case-insensitive on the repo slug", () => {
  assert.ok(anchorScore("Backend:src/**", "src/index.ts", "BACKEND") > 0);
});

test("two repos with the same file path no longer cross-flag each other's nodes (acceptance)", () => {
  // backend's src/index.ts and frontend's src/index.ts are distinguishable once anchors are qualified.
  const backendAnchor = "backend:src/index.ts";
  const frontendAnchor = "frontend:src/index.ts";
  assert.ok(anchorScore(backendAnchor, "src/index.ts", "backend") > 0);
  assert.equal(anchorScore(backendAnchor, "src/index.ts", "frontend"), 0);
  assert.ok(anchorScore(frontendAnchor, "src/index.ts", "frontend") > 0);
  assert.equal(anchorScore(frontendAnchor, "src/index.ts", "backend"), 0);
});

test("exact-file and glob scoring still behave as before once a qualifier is stripped", () => {
  const unqualified = anchorScore("src/lib/service.ts", "src/lib/service.ts");
  const qualified = anchorScore("backend:src/lib/service.ts", "src/lib/service.ts", "backend");
  assert.equal(unqualified, qualified, "qualifier itself doesn't change the specificity score");
});
