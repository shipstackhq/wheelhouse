import { test } from "node:test";
import assert from "node:assert/strict";
import { HOSTED_URL, onboarding } from "./onboarding";

/** The plugin path: its own commands only, no MCP-prompt stand-ins. */
const pluginCommands = (o: ReturnType<typeof onboarding>) => [o.installPlugin, o.linkRepo, o.buildMap, o.refreshMap, o.loginOptional, o.vscodeInstallLink];
const commands = (o: ReturnType<typeof onboarding>) => [...pluginCommands(o), o.mcpBuildMap, o.mcpRefreshMap, o.cli, o.mcp, o.rest];

test("no pasted command carries an API key: keys are typed hidden or read from an environment variable", () => {
  for (const origin of [HOSTED_URL, "http://localhost:3456"]) {
    for (const c of commands(onboarding({ origin, projectKey: "WH" }))) {
      assert.ok(!/wh_[A-Za-z0-9_]/.test(c), `a key literal in: ${c}`);
      assert.ok(!/Bearer (?!\$WHEELHOUSE_KEY)/.test(c), `a bearer token other than the variable in: ${c}`);
    }
  }
});

test("the plugin path uses the plugin's commands, with the project key filled in", () => {
  const o = onboarding({ origin: HOSTED_URL, projectKey: "WH" });
  assert.equal(o.linkRepo, "/wheelhouse:setup WH");
  assert.match(o.installPlugin, /\/plugin marketplace add shipstackhq\/wheelhouse-cli/);
  assert.match(o.installPlugin, /\/plugin install wheelhouse@shipstack/);
  assert.equal(o.buildMap, "/wheelhouse:map-codebase WH\n/wheelhouse:map-schema WH");
  assert.equal(o.refreshMap, "/wheelhouse:refresh-map WH");
  assert.ok(!pluginCommands(o).some((c) => c.includes("mcp__wheelhouse__")), "the plugin path does not use the MCP prompt commands");
});

test("with no or an empty project key the commands keep a KEY placeholder", () => {
  for (const projectKey of [undefined, null, "", "  "]) assert.equal(onboarding({ origin: HOSTED_URL, projectKey }).linkRepo, "/wheelhouse:setup KEY");
});

test("the CLI path names this server only when it is not the hosted one", () => {
  assert.equal(onboarding({ origin: HOSTED_URL, projectKey: "WH" }).cli, "npm install -g @shipstack/wheelhouse-cli\nwheelhouse login\nwheelhouse init --project WH");
  const own = onboarding({ origin: "https://wh.example.com/", projectKey: "WH" });
  assert.equal(own.cli, "npm install -g @shipstack/wheelhouse-cli\nwheelhouse login --url https://wh.example.com\nwheelhouse init --project WH --url https://wh.example.com");
});

test("the MCP and REST commands point at this server and use the variable, not a key", () => {
  const o = onboarding({ origin: "http://localhost:3456/", projectKey: "WH" });
  assert.match(o.mcp, /claude mcp add --transport http wheelhouse http:\/\/localhost:3456\/mcp/);
  assert.match(o.mcp, /read -rs WHEELHOUSE_KEY/);
  assert.match(o.rest, /http:\/\/localhost:3456\/api\/v1\/create_ticket/);
  assert.match(o.rest, /"project":"WH"/);
  assert.ok(o.rest.includes('Bearer $WHEELHOUSE_KEY'));
});

test("the VS Code install link follows the extension's format and names this plugin and marketplace", () => {
  const o = onboarding({ origin: HOSTED_URL, projectKey: "WH" });
  const u = new URL(o.vscodeInstallLink);
  assert.equal(u.protocol, "vscode:");
  assert.equal(u.host, "anthropic.claude-code");
  assert.equal(u.pathname, "/install-plugin");
  assert.equal(u.searchParams.get("plugin"), "wheelhouse");
  assert.equal(u.searchParams.get("marketplace"), "shipstackhq/wheelhouse-cli");
  assert.equal(o.marketplace, "shipstackhq/wheelhouse-cli");
  assert.match(o.installPlugin, /\/plugin install wheelhouse@shipstack/, "the terminal install names the same plugin");
});

test("the optional login uses npx, so nothing is installed, and names the server only when it is not the hosted one", () => {
  assert.equal(onboarding({ origin: HOSTED_URL }).loginOptional, "npx @shipstack/wheelhouse-cli login");
  assert.equal(onboarding({ origin: "https://wh.example.com/" }).loginOptional, "npx @shipstack/wheelhouse-cli login --url https://wh.example.com");
});

test("without the plugin, the MCP prompts stand in for the plugin's commands, with the project key filled in", () => {
  const o = onboarding({ origin: HOSTED_URL, projectKey: "WH" });
  assert.equal(o.mcpBuildMap, "/mcp__wheelhouse__map_codebase WH\n/mcp__wheelhouse__map_schema WH");
  assert.equal(o.mcpRefreshMap, "/mcp__wheelhouse__refresh_map WH");
  assert.ok(!o.mcpBuildMap.includes("/wheelhouse:"), "no plugin-only commands on the plugin-less path");
  assert.equal(onboarding({ origin: HOSTED_URL }).mcpRefreshMap, "/mcp__wheelhouse__refresh_map KEY");
});
