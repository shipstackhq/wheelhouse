/** A directory tree built from the flat list of file paths GitHub returns, for the anchor picker. */
export type FileTreeNode = { name: string; path: string; isFile: boolean; children: Map<string, FileTreeNode> };

export function buildFileTree(paths: string[]): FileTreeNode {
  const root: FileTreeNode = { name: "", path: "", isFile: false, children: new Map() };
  for (const full of paths) {
    const parts = full.split("/");
    let node = root;
    let acc = "";
    parts.forEach((part, i) => {
      acc = acc ? `${acc}/${part}` : part;
      const isFile = i === parts.length - 1;
      let next = node.children.get(part);
      if (!next) {
        next = { name: part, path: acc, isFile, children: new Map() };
        node.children.set(part, next);
      }
      node = next;
    });
  }
  return root;
}

/** Folders first, then by name. */
export const sortedChildren = (node: FileTreeNode) =>
  [...node.children.values()].sort((a, b) => (a.isFile !== b.isFile ? (a.isFile ? 1 : -1) : a.name.localeCompare(b.name)));

/** Does any file under this folder match (`filter` is already lower case)? */
export function containsMatch(node: FileTreeNode, filter: string): boolean {
  for (const child of node.children.values()) {
    if (child.isFile) {
      if (child.path.toLowerCase().includes(filter)) return true;
    } else if (containsMatch(child, filter)) return true;
  }
  return false;
}

/** Rough reading time from word count, Confluence-style ("12 min"). ~200 wpm, minimum 1. */
export function readTime(body: string): number {
  const words = body.trim() ? body.trim().split(/\s+/).length : 0;
  return Math.max(1, Math.round(words / 200));
}

/** The text under a `## Heading` of a Markdown doc, up to the next `## ` heading or the end. */
export function sectionOf(body: string, heading: string): string {
  const m = new RegExp(`^##\\s*${heading}\\s*$([\\s\\S]*?)(?=^##\\s|$(?![\\s\\S]))`, "im").exec(body);
  return m ? m[1].trim() : "";
}
