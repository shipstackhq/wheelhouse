import { INTEGRATION_ICONS, type IconPair } from "../../components/icons";

/** The services Wheelhouse connects to. Each is a page under Settings → Integrations; the settings sidebar and the overview list this. */
export type Integration = { id: string; label: string; hint: string; to: string; icon: IconPair };

export const INTEGRATIONS: Integration[] = [
  {
    id: "github",
    label: "GitHub",
    hint: "Connect repositories: pushes, pull requests and CI results show up on your issues, and runs on a device open their pull request here.",
    to: "/settings/integrations/github",
    icon: INTEGRATION_ICONS.github,
  },
];

/** The GitHub page for a team (the repositories belong to a team, so the page works on one at a time). */
export const githubIntegrationPath = (teamKey: string) => `/settings/integrations/github?team=${encodeURIComponent(teamKey)}`;
