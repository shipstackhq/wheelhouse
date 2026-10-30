import type { ComponentType } from "react";
import { useQuery } from "@tanstack/react-query";
import { INTEGRATION_ICONS, type IconPair } from "../../components/icons";
import { githubQuery } from "../../lib/queries";
import { useServices } from "../../lib/services";
import { useTeams } from "../../lib/session";
import { useWorkspaceSlug } from "../../lib/workspace";
import { GithubSettings } from "./github/github-settings";

/** Where an integration stands, worked out from its own data (there is no workspace-level integrations table). */
export type IntegrationState = "loading" | "not_enabled" | "enabled" | "attention";

/** What an integration's own data says right now, and what its two main actions do. */
export type IntegrationRuntime = {
  state: IntegrationState;
  /** A line under the state (why it needs attention, why it cannot be enabled here). */
  note: string | null;
  /** Enable: a full page load that starts the integration's own set-up flow; null when it cannot be started by this person. */
  enableHref: string | null;
  /** Disable: disconnects it; null when this person cannot. */
  disable: (() => Promise<void>) | null;
};

/**
 * One integration. This one entry drives the store card, the sidebar item and the page: add an entry to INTEGRATIONS and all three show it.
 * The details are a fixed schema, so every integration page reads alike.
 */
export type Integration = {
  id: string;
  name: string;
  summary: string;
  maker: string;
  category: string;
  /** Three to five bullets in plain words. */
  whatItDoes: string[];
  /** The permissions it asks for, and what Wheelhouse reads and writes. */
  whatItNeeds: string[];
  links: { label: string; href: string }[];
  icon: IconPair;
  /** Works out the state from the integration's own data, and what Enable and Disable do. */
  useRuntime: () => IntegrationRuntime;
  /** The integration's settings, shown on its page. */
  Settings: ComponentType;
};

/** `/settings/integrations/:id` */
export const integrationPath = (id: string) => `/settings/integrations/${id}`;

const useGithubRuntime = (): IntegrationRuntime => {
  const { api, queryClient } = useServices();
  const slug = useWorkspaceSlug();
  const team = useTeams().data?.[0];
  const key = team?.key ?? "";
  const query = useQuery({ ...githubQuery(api, key), enabled: !!team });
  const status = query.data;
  if (!status && query.isError) return { state: "attention", note: "Could not read GitHub's status right now.", enableHref: null, disable: null };
  if (!status) return { state: "loading", note: null, enableHref: null, disable: null };
  if (!status.configured) {
    const set = status.isOwner && status.missing.length ? ` An administrator creates a GitHub App and sets ${status.missing.join(", ")}.` : "";
    return { state: "not_enabled", note: `GitHub is not set up on this server yet.${set}`, enableHref: null, disable: null };
  }
  const connected = status.connected;
  const state: IntegrationState = !connected ? "not_enabled" : status.installations.some((i) => i.failed) ? "attention" : "enabled";
  return {
    state,
    note: state === "attention" ? "Could not load an installation's repositories from GitHub." : !status.isOwner && !connected ? "A workspace owner connects GitHub." : null,
    enableHref: status.isOwner ? `/api/github/install?workspace=${encodeURIComponent(slug ?? "")}&team=${encodeURIComponent(key)}` : null,
    disable: status.isOwner && connected
      ? async () => {
          for (const i of status.installations) await api.repos.disconnectGithub(key, i.installationId);
          await queryClient.invalidateQueries();
        }
      : null,
  };
};

export const INTEGRATIONS: Integration[] = [
  {
    id: "github",
    name: "GitHub",
    summary: "Pushes, pull requests and CI results show up on your issues.",
    maker: "GitHub",
    category: "Source control",
    whatItDoes: [
      "Reports every push to a connected repository's default branch, whoever made it.",
      "Shows pull requests and CI results on the issues they mention.",
      "Lets runs on a device open their pull request here.",
      "Adds each connected repository to the map as a service.",
    ],
    whatItNeeds: [
      "Install the Wheelhouse GitHub App on your account or organisation (a workspace owner does this).",
      "Reads: repository lists, pushes, pull requests and CI check results, through webhooks.",
      "Writes: nothing back to your repositories.",
    ],
    links: [
      { label: "GitHub Apps documentation", href: "https://docs.github.com/en/apps" },
      { label: "Support", href: "mailto:info@gostampd.com" },
    ],
    icon: INTEGRATION_ICONS.github,
    useRuntime: useGithubRuntime,
    Settings: GithubSettings,
  },
];

export const findIntegration = (id: string | undefined) => INTEGRATIONS.find((i) => i.id === id);

/** The integrations that are on (or need attention), in definition order, for the sidebar. INTEGRATIONS is a constant list, so the hooks run in a stable order. */
export function useEnabledIntegrations(): Integration[] {
  const states: IntegrationState[] = [];
  for (const i of INTEGRATIONS) states.push(i.useRuntime().state);  return INTEGRATIONS.filter((_, n) => states[n] === "enabled" || states[n] === "attention");
}

/** The GitHub page for a team (the repositories belong to a team, so the page works on one at a time). */
export const githubIntegrationPath = (teamKey: string) => `${integrationPath("github")}?team=${encodeURIComponent(teamKey)}`;
