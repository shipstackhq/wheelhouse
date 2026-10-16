import type { BoardColumn, BoardMember, BoardNode, BoardTicket } from "@wheelhouse/api-client";

export type Col = Pick<BoardColumn, "id" | "name">;
export type NodeLite = BoardNode;
export type Member = BoardMember;
export type Ticket = BoardTicket;

export const PRIORITY_STYLE: Record<string, string> = {
  urgent: "bg-danger/20 text-danger",
  high: "bg-warn/20 text-warn",
  medium: "bg-panel-2 text-muted",
  low: "bg-panel-2 text-muted/70",
};
