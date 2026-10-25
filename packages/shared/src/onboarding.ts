/** The hosted instance. The plugin and CLI default to it, so commands only name a URL when this server is something else. */
export const HOSTED_URL = "https://wheelhouse.shipstack.run";

/**
 * Every command the API keys page asks someone to paste. Kept apart from the page so a test can check them: none may carry
 * an API key (shell history, screen shares), and the project key and server URL must be the real ones.
 */
export function onboarding({ origin, teamKey }: { origin: string; teamKey?: string | null }) {
  const key = teamKey?.trim() || "KEY";
  const url = origin.replace(/\/+$/, "");
  const urlFlag = url === HOSTED_URL ? "" : ` --url ${url}`;
  return {
    teamKey: key,
    url,
    /** The terminal's text commands. The VS Code extension has no `/plugin`: it uses the `/plugins` dialog or this link. */
    installPlugin: "/plugin marketplace add shipstackhq/wheelhouse-cli\n/plugin install wheelhouse@shipstack",
    marketplace: "shipstackhq/wheelhouse-cli",
    vscodeInstallLink: "vscode://anthropic.claude-code/install-plugin?plugin=wheelhouse&marketplace=shipstackhq/wheelhouse-cli",
    /** Optional with the plugin: lets the git hooks (which cannot read the keychain) report commits made outside Claude Code. */
    loginOptional: `npx @shipstack/wheelhouse-cli login${urlFlag}`,
    linkRepo: `/wheelhouse:setup ${key}`,
    buildMap: `/wheelhouse:map-codebase ${key}\n/wheelhouse:map-schema ${key}`,
    refreshMap: `/wheelhouse:refresh-map ${key}`,
    /** Claude Code without the plugin: the MCP server's own prompts stand in for the plugin's /wheelhouse: commands. */
    mcpBuildMap: `/mcp__wheelhouse__map_codebase ${key}\n/mcp__wheelhouse__map_schema ${key}`,
    mcpRefreshMap: `/mcp__wheelhouse__refresh_map ${key}`,
    cli: `npm install -g @shipstack/wheelhouse-cli\nwheelhouse login${urlFlag}\nwheelhouse init --project ${key}${urlFlag}`,
    // `read -s` keeps the key out of the terminal and out of shell history; the commands below only name the variable.
    mcp: `read -rs WHEELHOUSE_KEY; export WHEELHOUSE_KEY   # paste the key; nothing is shown\nclaude mcp add --transport http wheelhouse ${url}/mcp --header "Authorization: Bearer $WHEELHOUSE_KEY"`,
    rest: `curl -X POST ${url}/api/v1/create_issue \\\n  -H "Authorization: Bearer $WHEELHOUSE_KEY" -H "Content-Type: application/json" \\\n  -d '{"project":"${key}","title":"Fix flaky login test","status":"Todo"}'`,
  };
}
