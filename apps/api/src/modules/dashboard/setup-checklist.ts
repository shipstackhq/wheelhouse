/**
 * The team setup checklist (WH-69): pure status computation from already-fetched data, so the team-page
 * banner and the agent briefing can share one source of truth instead of drifting apart. No DB access here —
 * callers (checklistForTeam below, or a test) pass in plain rows.
 */

export type ChecklistInput = {
  teamKey: string;
  repositories: { provider: "github" | "local"; lifecycle: "live" | "being_replaced" | "planned" | "retired" }[];
  /** Work sessions (machines/clients) seen for this team, active or not. */
  sessionCount: number;
  /** Active (non-revoked) API keys for the workspace. */
  activeAgentKeyCount: number;
  /** Map nodes for this team, any layer. */
  nodeCount: number;
  /** Workspace members (including the creator) + pending join invites. */
  memberCount: number;
  pendingInviteCount: number;
};

export type ChecklistItem = {
  id: "repos" | "machines" | "agents" | "map" | "teammates";
  label: string;
  done: boolean;
  /** ADR-7-style truth-telling status line, shown on the banner and reused verbatim in the briefing. */
  status: string;
  href: string;
};

export type ChecklistState = {
  items: ChecklistItem[];
  done: boolean;
  doneCount: number;
  total: number;
};

/**
 * ADR-7 fallback framing, reused from briefing.ts's repository section: GitHub-connected repos are authoritative
 * (every push to the default branch is reported); local/other-host links are best effort (only from machines
 * running the plugin or CLI); no repository at all is explicitly labelled off, not silently assumed.
 */
function repoStatus(repos: ChecklistInput["repositories"]): { done: boolean; status: string } {
  const live = repos.filter((r) => r.lifecycle !== "retired");
  if (!live.length) return { done: false, status: "No repository connected yet — what landed isn't tracked." };
  const github = live.filter((r) => r.provider === "github").length;
  const local = live.length - github;
  if (github && local) {
    return { done: true, status: `${github} on GitHub (authoritative) and ${local} local-link (best effort, only from machines running the plugin or CLI).` };
  }
  if (github) {
    return { done: true, status: `${github} connected via GitHub — authoritative, every push to the default branch is reported.` };
  }
  return { done: true, status: `${local} local-link${local === 1 ? "" : "s"} — best effort, reported only from machines running the plugin or CLI.` };
}

export function checklistStatus(input: ChecklistInput): ChecklistState {
  const repo = repoStatus(input.repositories);

  const machinesDone = input.sessionCount > 0;
  const agentsDone = input.activeAgentKeyCount > 0;
  const mapDone = input.nodeCount > 0;
  const teammatesDone = input.memberCount > 1;

  const items: ChecklistItem[] = [
    { id: "repos", label: "Repositories connected", done: repo.done, status: repo.status, href: `/settings/integrations/github?team=${encodeURIComponent(input.teamKey)}` },
    {
      id: "machines",
      label: "Machines linked",
      done: machinesDone,
      status: machinesDone
        ? `${input.sessionCount} client session${input.sessionCount === 1 ? "" : "s"} seen.`
        : "No machine has connected yet (link one with /wheelhouse:setup or the CLI).",
      href: `/settings/integrations/github?team=${encodeURIComponent(input.teamKey)}`,
    },
    {
      id: "agents",
      label: "Agents connected",
      done: agentsDone,
      status: agentsDone
        ? `${input.activeAgentKeyCount} active API key${input.activeAgentKeyCount === 1 ? "" : "s"} for this workspace.`
        : "No agent API key yet.",
      href: "/api-keys",
    },
    {
      id: "map",
      label: "Map built",
      done: mapDone,
      status: mapDone ? `${input.nodeCount} map node${input.nodeCount === 1 ? "" : "s"} described.` : "The map is empty — nothing described yet.",
      href: `/t/${input.teamKey}/map`,
    },
    {
      id: "teammates",
      label: "Teammates invited",
      done: teammatesDone,
      status: teammatesDone
        ? `${input.memberCount} teammate${input.memberCount === 1 ? "" : "s"} on the workspace${input.pendingInviteCount ? `, ${input.pendingInviteCount} invite${input.pendingInviteCount === 1 ? "" : "s"} pending` : ""}.`
        : input.pendingInviteCount
          ? `${input.pendingInviteCount} invite${input.pendingInviteCount === 1 ? "" : "s"} pending, no one has joined yet.`
          : "Just you so far.",
      href: "/workspace",
    },
  ];

  const doneCount = items.filter((i) => i.done).length;
  return { items, done: doneCount === items.length, doneCount, total: items.length };
}

/** A one-line summary for the briefing, built from the same state so the UI and the agent briefing can't drift. */
export function checklistBriefingLine(state: ChecklistState): string {
  return `Setup: ${state.items.map((i) => `${i.label.toLowerCase()} ${i.done ? "✓" : "✗"}`).join(", ")}.`;
}
