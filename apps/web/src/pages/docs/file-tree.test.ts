import { describe, expect, test } from "vitest";
import { buildFileTree, containsMatch, readTime, sectionOf, sortedChildren } from "./file-tree";

describe("the file tree for the anchor picker", () => {
  const tree = buildFileTree(["README.md", "src/lib/a.ts", "src/lib/b.ts", "src/index.ts", "apps/web/index.html"]);

  test("nests paths into folders, with the full path on every node", () => {
    const src = tree.children.get("src")!;
    expect([src.isFile, src.path]).toEqual([false, "src"]);
    expect(src.children.get("lib")!.children.get("a.ts")!.path).toBe("src/lib/a.ts");
    expect(tree.children.get("README.md")!.isFile).toBe(true);
  });

  test("folders come first, then files, each by name", () => {
    expect(sortedChildren(tree).map((n) => n.name)).toEqual(["apps", "src", "README.md"]);
    expect(sortedChildren(tree.children.get("src")!).map((n) => n.name)).toEqual(["lib", "index.ts"]);
  });

  test("a folder matches a filter when any file under it does", () => {
    expect(containsMatch(tree.children.get("src")!, "b.ts")).toBe(true);
    expect(containsMatch(tree.children.get("src")!, "html")).toBe(false);
    expect(containsMatch(tree.children.get("apps")!, "index.html")).toBe(true);
  });
});

test("reading time is words at 200 a minute, never less than a minute", () => {
  expect(readTime("")).toBe(1);
  expect(readTime("one two three")).toBe(1);
  expect(readTime("word ".repeat(1000))).toBe(5);
});

describe("the sections of a decision record", () => {
  const body = "# Decision: Use REST\n\n## Context\nWe need one protocol.\n\n## Decision\nREST over HTTP. Zero streaming, a Zebra crossing.\n\n## Consequences\nNo streaming yet.\n";

  test("each section is the text up to the next heading, trimmed", () => {
    expect(sectionOf(body, "Context")).toBe("We need one protocol.");
    expect(sectionOf(body, "Decision")).toBe("REST over HTTP. Zero streaming, a Zebra crossing.");
  });

  test("the last section runs to the end, and a capital Z in the text does not cut a section short", () => {
    expect(sectionOf(body, "Consequences")).toBe("No streaming yet.");
    expect(sectionOf("## Decision\nAbout Z and then more", "Decision")).toBe("About Z and then more");
  });

  test("a missing section is empty; headings match in any case", () => {
    expect(sectionOf("# Only a title", "Context")).toBe("");
    expect(sectionOf("## context\nlower", "Context")).toBe("lower");
  });
});
