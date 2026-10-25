import { CATALOG, latest } from "@wheelhouse/shared/agents/catalog/index";
import { toView } from "@wheelhouse/shared/agents/render";
import { parseAgentProfile, type AgentProfile } from "@wheelhouse/shared/agents/schema";
import type { AgentRow } from "./agents.repository";

/** The profile an agent row stands for: the stored one, or the catalog version it follows (the latest unless pinned). Validated on every read. */
export function effectiveProfile(row: Pick<AgentRow, "source" | "catalogSlug" | "pinnedVersion" | "profile">): AgentProfile {
  if (row.source === "custom") return parseAgentProfile(row.profile);
  const versions = CATALOG[row.catalogSlug!];
  return versions[(row.pinnedVersion ?? versions.length) - 1];
}

/** A catalog agent as the Agents page lists it; `row` exists once a workspace has pinned or used it. */
export function catalogView(slug: string, row?: Pick<AgentRow, "pinnedVersion">) {
  const versions = CATALOG[slug];
  const pinnedVersion = row?.pinnedVersion ?? null;
  return { ...toView(pinnedVersion ? versions[pinnedVersion - 1] : latest(slug)!), source: "catalog" as const, latestVersion: versions.length, pinnedVersion, version: pinnedVersion ?? versions.length };
}

/** A custom agent: its profile's view and the whole profile (the workspace's own text, for the edit form), with its team (null: workspace-wide) and version. */
export const customView = (row: AgentRow) => ({ ...toView(effectiveProfile(row)), profile: effectiveProfile(row), source: "custom" as const, teamKey: row.teamKey, version: row.version, createdBy: row.createdBy });

/** A roster entry: the catalog view for a catalog row, else the custom view. */
export const agentView = (row: AgentRow) => (row.source === "catalog" ? catalogView(row.catalogSlug!, row) : customView(row));
