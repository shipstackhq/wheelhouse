/**
 * Two blocks Markdown has and Lexical's own transformers do not: tables (GFM pipe tables) and dividers (`---`).
 * Both read and write the same text they were given, so a doc that is opened and saved untouched does not change.
 */
import type { JSX } from "react";
import {
  $convertFromMarkdownString,
  $convertToMarkdownString,
  isTableRowDivider,
  TEXT_FORMAT_TRANSFORMERS,
  TEXT_MATCH_TRANSFORMERS,
  type ElementTransformer,
  type MultilineElementTransformer,
} from "@lexical/markdown";
import { $createTableCellNode, $createTableNode, $createTableRowNode, $isTableCellNode, $isTableNode, $isTableRowNode, TableCellHeaderStates, TableCellNode, TableNode, TableRowNode } from "@lexical/table";
import { $applyNodeReplacement, DecoratorNode, type ElementFormatType, type LexicalNode, type SerializedLexicalNode } from "lexical";
import { IMAGE_TRANSFORMER } from "./image-node";

// ───────── divider ─────────

export class DividerNode extends DecoratorNode<JSX.Element> {
  static getType() {
    return "divider";
  }
  static clone(node: DividerNode) {
    return new DividerNode(node.__key);
  }
  static importJSON() {
    return $createDividerNode();
  }
  exportJSON(): SerializedLexicalNode {
    return { ...super.exportJSON(), type: "divider", version: 1 };
  }
  createDOM() {
    return document.createElement("div");
  }
  updateDOM() {
    return false;
  }
  isInline() {
    return false;
  }
  getTextContent() {
    return "---";
  }
  decorate() {
    return <hr className="my-6 border-line" />;
  }
}

export const $createDividerNode = () => $applyNodeReplacement(new DividerNode());
export const $isDividerNode = (n: LexicalNode | null | undefined): n is DividerNode => n instanceof DividerNode;

export const DIVIDER_TRANSFORMER: ElementTransformer = {
  dependencies: [DividerNode],
  export: (node) => ($isDividerNode(node) ? "---" : null),
  regExp: /^(?:---|\*\*\*|___)\s?$/,
  replace: (parent, _children, _match, isImport) => {
    const divider = $createDividerNode();
    // typed in the editor on the last line: keep an empty line below to carry on writing; on import the line simply becomes the divider
    if (isImport || parent.getNextSibling() != null) parent.replace(divider);
    else parent.insertBefore(divider);
    divider.selectNext();
  },
  type: "element",
};

// ───────── tables ─────────

const ROW = /^\s*\|.*\|\s*$/;
// Inside a cell only inline Markdown applies (bold, code, links, images), never headings or lists.
const CELL_TRANSFORMERS = [IMAGE_TRANSFORMER, ...TEXT_FORMAT_TRANSFORMERS, ...TEXT_MATCH_TRANSFORMERS];

/** Split a pipe row into trimmed cell texts; `\|` is a pipe inside a cell. */
function cellsOf(line: string): string[] {
  const inner = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return inner.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
}

const ALIGN: Record<string, ElementFormatType> = { left: "left", center: "center", right: "right" };
const alignOf = (divider: string): ElementFormatType => {
  const l = divider.startsWith(":");
  const r = divider.endsWith(":");
  return l && r ? ALIGN.center : r ? ALIGN.right : l ? ALIGN.left : "";
};

function $cell(text: string, header: boolean, format: ElementFormatType) {
  const cell = $createTableCellNode(header ? TableCellHeaderStates.ROW : TableCellHeaderStates.NO_STATUS);
  $convertFromMarkdownString(text, CELL_TRANSFORMERS, cell, false);
  if (format) cell.setFormat(format);
  return cell;
}

export const TABLE_TRANSFORMER: MultilineElementTransformer = {
  dependencies: [TableNode, TableRowNode, TableCellNode],
  regExpStart: ROW,
  handleImportAfterStartMatch: ({ lines, rootNode, startLineIndex }) => {
    let end = startLineIndex;
    while (end + 1 < lines.length && ROW.test(lines[end + 1])) end++;
    // A table is a header row, a divider row, then body rows; pipes without a divider are ordinary text.
    if (end - startLineIndex < 1 || !isTableRowDivider(lines[startLineIndex + 1])) return null;
    const header = cellsOf(lines[startLineIndex]);
    const aligns = cellsOf(lines[startLineIndex + 1]).map(alignOf);
    const width = Math.max(header.length, aligns.length);
    const table = $createTableNode();
    const rows = [header, ...lines.slice(startLineIndex + 2, end + 1).map(cellsOf)];
    rows.forEach((cells, r) => {
      const row = $createTableRowNode();
      for (let c = 0; c < width; c++) row.append($cell(cells[c] ?? "", r === 0, aligns[c] ?? ""));
      table.append(row);
    });
    rootNode.append(table);
    return [true, end];
  },
  export: (node) => {
    if (!$isTableNode(node)) return null;
    const rows = node.getChildren().filter($isTableRowNode);
    if (!rows.length) return null;
    const text = (cell: LexicalNode) => ($isTableCellNode(cell) ? $convertToMarkdownString(CELL_TRANSFORMERS, cell, false).replace(/\n+/g, " ").replace(/\|/g, "\\|").trim() : "");
    const line = (cells: string[]) => `|${cells.map((c) => (c ? ` ${c} ` : " ")).join("|")}|`;
    const first = rows[0].getChildren();
    const divider = first.map((c) => {
      const f = $isTableCellNode(c) ? c.getFormatType() : "";
      return f === "center" ? ":---:" : f === "right" ? "---:" : f === "left" ? ":---" : "---";
    });
    return [line(first.map(text)), line(divider), ...rows.slice(1).map((r) => line(r.getChildren().map(text)))].join("\n");
  },
  // Import is handled whole by handleImportAfterStartMatch above; this is only here because the type asks for it.
  replace: () => false,
  type: "multiline-element",
};
