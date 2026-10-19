import type { ComponentType } from "react";
import * as w from "./widgets";

/**
 * Dashboard layout. Order = render order on a 12-column grid (stacks to one
 * column on small screens). Add a widget by appending an entry here.
 */
export type Span = "full" | "two-thirds" | "half" | "third";

export type WidgetDef = {
  id: string;
  title: string;
  span: Span;
  Component: ComponentType;
};

export const WIDGETS: WidgetDef[] = [
  { id: "kpis", title: "Key numbers", span: "full", Component: w.KpiRow },
  { id: "progress", title: "Project progress", span: "two-thirds", Component: w.ProjectProgress },
  { id: "attention", title: "Needs attention", span: "third", Component: w.NeedsAttention },
  { id: "throughput", title: "Throughput", span: "half", Component: w.Throughput },
  { id: "activity-split", title: "Who's doing the work", span: "half", Component: w.ActivitySplit },
  { id: "agents", title: "Agents", span: "third", Component: w.AgentQueues },
  { id: "sync", title: "Sync health", span: "third", Component: w.SyncHealth },
  { id: "recent", title: "Recent activity", span: "third", Component: w.RecentActivity },
];

/**
 * A project's Overview: the same widgets, read for that one project, with Focus first. Add a widget here to put it on every
 * project's page. (The project progress card is the project's own columns, so it sits beside what needs attention.)
 */
export const PROJECT_WIDGETS: WidgetDef[] = [
  { id: "kpis", title: "Key numbers", span: "full", Component: w.KpiRow },
  { id: "focus", title: "Focus", span: "two-thirds", Component: w.ProjectFocus },
  { id: "attention", title: "Needs attention", span: "third", Component: w.NeedsAttention },
  { id: "progress", title: "Progress", span: "two-thirds", Component: w.ProjectProgress },
  { id: "agents", title: "Agents", span: "third", Component: w.AgentQueues },
  { id: "throughput", title: "Throughput", span: "half", Component: w.Throughput },
  { id: "activity-split", title: "Who's doing the work", span: "half", Component: w.ActivitySplit },
  { id: "sync", title: "Sync health", span: "half", Component: w.SyncHealth },
  { id: "recent", title: "Recent activity", span: "half", Component: w.RecentActivity },
];

export const SPAN_CLASS: Record<Span, string> = {
  full: "xl:col-span-12",
  "two-thirds": "xl:col-span-8",
  half: "xl:col-span-6",
  third: "xl:col-span-4",
};
