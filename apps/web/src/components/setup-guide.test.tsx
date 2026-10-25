import { test } from "vitest";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { SetupGuide } from "./setup-guide";
import { HOSTED_URL, onboarding } from "@wheelhouse/shared/onboarding";

const html = (origin = HOSTED_URL, teamKey: string | null = "WH") => renderToStaticMarkup(<SetupGuide cmd={onboarding({ origin, teamKey })} />);
/** What a reader sees: tags become spaces, entities are decoded, whitespace is collapsed. */
const text = (h: string) =>
  h
    .replace(/<!-- -->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ");
/** The section of the page between two anchors. */
const section = (h: string, id: string) => {
  const start = h.indexOf(`id="${id}"`);
  assert.ok(start >= 0, `section ${id} exists`);
  const next = h.indexOf('id="setup-', start + 10);
  return h.slice(start, next < 0 ? undefined : next);
};

test("the comparison names the three setups and says the CLI is needed only without Claude Code", () => {
  const t = text(html());
  assert.ok(t.includes("A. Claude Code with the Wheelhouse plugin") && t.includes("recommended"));
  assert.ok(t.includes("B. Claude Code without the plugin"));
  assert.ok(t.includes("C. No Claude Code"));
  const rows = html().split("<tr").slice(2); // skip the table opener and its header row
  assert.equal(rows.length, 3);
  assert.match(text(rows[0]), /No\. The plugin includes its own copy\./);
  assert.match(text(rows[1]), /No\./);
  assert.match(text(rows[2]), /Yes\. The only case that needs it\./);
});

test("the plugin section tells a VS Code user to use /plugins, not /plugin, and links to the install dialog", () => {
  const a = section(html(), "setup-plugin");
  const t = text(a);
  assert.ok(t.includes("In the VS Code extension") && t.includes("/plugins"));
  assert.ok(t.includes("isn't available in this environment"), "explains the error people hit");
  assert.ok(t.includes("shipstackhq/wheelhouse-cli") && t.includes("Install for you") && t.includes("Restart Claude to apply plugin changes"));
  assert.ok(a.includes('href="vscode://anthropic.claude-code/install-plugin?plugin=wheelhouse&amp;marketplace=shipstackhq/wheelhouse-cli"'));
  assert.ok(t.includes("In a terminal") && t.includes("/plugin marketplace add shipstackhq/wheelhouse-cli") && t.includes("/plugin install wheelhouse@shipstack"));
  assert.ok(t.includes("/mcp") && t.includes("connected"));
});

test("the plugin section says the CLI is not needed, and offers the optional login", () => {
  const t = text(section(html(), "setup-plugin"));
  assert.match(t, /Do I need\s*wheelhouse-cli\s*\?\s*No\./);
  assert.ok(t.includes("no separate install and no second key"));
  assert.ok(t.includes("Node.js 18+ and git"));
  assert.ok(t.includes("npx @shipstack/wheelhouse-cli login"));
  assert.ok(!t.includes("npm install -g"), "the plugin path never asks for the global install");
});

test("the plugin section links the repo and builds the map with the plugin's commands and the project key", () => {
  const t = text(section(html(HOSTED_URL, "WH"), "setup-plugin"));
  for (const c of ["/wheelhouse:setup WH", "/wheelhouse:map-codebase WH", "/wheelhouse:map-schema WH", "/wheelhouse:refresh-map WH"]) assert.ok(t.includes(c), c);
  assert.ok(!t.includes("/mcp__wheelhouse__"), "the MCP-only prompts do not appear in the plugin section");
  assert.ok(text(section(html(HOSTED_URL, null), "setup-plugin")).includes("/wheelhouse:setup KEY"), "a placeholder when there is no single project");
});

test("the plugin-less section gives the MCP command and prompts, and says what is missing", () => {
  const t = text(section(html(), "setup-mcp"));
  assert.ok(t.includes("claude mcp add --transport http wheelhouse") && t.includes("read -rs WHEELHOUSE_KEY"));
  assert.ok(t.includes("/mcp__wheelhouse__map_codebase WH") && t.includes("/mcp__wheelhouse__refresh_map WH"));
  assert.ok(t.includes("do not get the hooks"));
  assert.ok(t.includes("and you do not need the CLI"));
  assert.ok(!t.includes("/wheelhouse:setup"), "the plugin's commands do not exist without the plugin");
});

test("the no-Claude-Code section is the one that installs the CLI", () => {
  const t = text(section(html(), "setup-cli"));
  assert.ok(t.includes("This is the one setup that needs the command line tool"));
  assert.ok(t.includes("npm install -g @shipstack/wheelhouse-cli") && t.includes("wheelhouse init --project WH"));
  const everything = text(html());
  assert.equal(everything.split("npm install -g").length - 1, 1, "the global install appears only in this section");
});

test("a self-hosted server's URL is used throughout, and no API key appears anywhere on the page", () => {
  const h = html("https://wh.example.com/");
  const t = text(h);
  assert.ok(t.includes("https://wh.example.com") && !t.includes(`${HOSTED_URL}`), "the server's own URL");
  assert.ok(t.includes("https://wh.example.com/mcp"));
  assert.ok(t.includes("wheelhouse login --url https://wh.example.com"));
  assert.ok(!/wh_[A-Za-z0-9]{6}/.test(h), "no key-looking string");
  assert.ok(!/Bearer (?!\$WHEELHOUSE_KEY)/.test(t), "no bearer token other than the variable");
});
