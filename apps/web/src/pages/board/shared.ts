import type { BoardStatus, BoardMember, BoardNode, BoardIssue } from "@wheelhouse/api-client";

export type Col = Pick<BoardStatus, "id" | "name"> & Partial<Pick<BoardStatus, "role" | "color">>;
export type NodeLite = BoardNode;
export type Member = BoardMember;
export type Issue = BoardIssue;

export const PRIORITY_STYLE: Record<string, string> = {
  urgent: "bg-danger/20 text-danger",
  high: "bg-warn/20 text-warn",
  medium: "bg-panel-2 text-muted",
  low: "bg-panel-2 text-muted/70",
  none: "bg-panel-2 text-muted/50",
};
