import { CopyBlock } from "@/components/copy-block";
import type { onboarding } from "@wheelhouse/core/lib/onboarding";

type Cmd = ReturnType<typeof onboarding>;

const code = (s: string) => <code className="font-mono">{s}</code>;

/**
 * Which way to connect, and what each way needs. Three setups: Claude Code with the Wheelhouse plugin (the
 * `wheelhouse-cli` is built in, so it is not installed separately), Claude Code without the plugin, and no Claude
 * Code at all (the one case that needs the CLI). Commands come from onboarding() so they stay tested.
 */
/** Narrows the opening line to steer toward one setup when the caller already knows which one fits (e.g. the
 * onboarding wizard, after step 2's code-location answer). The full 3-way table and all three cards still render —
 * this doesn't fork the markup, just adds a pointer above it. */
export function SetupGuide({ cmd, emphasize }: { cmd: Cmd; emphasize?: "plugin" | "mcp" | "cli" }) {
  const hint = emphasize && {
    plugin: "Since your code lives in a connected repo, setup A (the plugin) gets you the most — hooks included.",
    mcp: "Plain MCP tools work either way; pick setup A instead if you also want hooks and the /wheelhouse: commands.",
    cli: "Without Claude Code, setup C (the CLI) is the one you need.",
  }[emphasize];
  return (
    <>
      <div className="card space-y-3 p-5">
        <h2 className="font-medium">2. Pick your setup</h2>
        <p className="text-sm text-muted">Find the row that matches how you work, then follow its section below.</p>
        {hint && <p className="text-sm text-accent">{hint}</p>}
        <div className="overflow-x-auto">
          <table className="w-full min-w-[40rem] border-collapse text-left text-sm">
            <thead>
              <tr className="border-b border-line text-xs text-muted">
                <th className="py-2 pr-3 font-medium">You use</th>
                <th className="py-2 pr-3 font-medium">What you get</th>
                <th className="py-2 pr-3 font-medium">Need {code("wheelhouse-cli")}?</th>
                <th className="py-2 font-medium">Also needs</th>
              </tr>
            </thead>
            <tbody className="align-top">
              <tr className="border-b border-line">
                <td className="py-2 pr-3">
                  <a className="text-accent" href="#setup-plugin">A. Claude Code with the Wheelhouse plugin</a>
                  <span className="chip ml-2 bg-accent/15 text-accent">recommended</span>
                </td>
                <td className="py-2 pr-3 text-muted">
                  The board and map tools, {code("/wheelhouse:")} commands, and hooks that brief Claude when a session starts, track what it
                  edits and check the board before each turn ends.
                </td>
                <td className="py-2 pr-3"><strong>No.</strong> <span className="text-muted">The plugin includes its own copy.</span></td>
                <td className="py-2 text-muted">Node.js 18+ and git</td>
              </tr>
              <tr className="border-b border-line">
                <td className="py-2 pr-3"><a className="text-accent" href="#setup-mcp">B. Claude Code without the plugin</a></td>
                <td className="py-2 pr-3 text-muted">
                  The board and map tools only. Claude uses them when it decides to; nothing tracks its edits or reports commits for you.
                </td>
                <td className="py-2 pr-3"><strong>No.</strong></td>
                <td className="py-2 text-muted">Nothing extra</td>
              </tr>
              <tr>
                <td className="py-2 pr-3"><a className="text-accent" href="#setup-cli">C. No Claude Code</a> <span className="text-muted">(other editors, scripts)</span></td>
                <td className="py-2 pr-3 text-muted">Link a repo and report commits to the board and map from the command line.</td>
                <td className="py-2 pr-3"><strong>Yes.</strong> <span className="text-muted">The only case that needs it.</span></td>
                <td className="py-2 text-muted">Node.js 18+ and git</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div id="setup-plugin" className="card space-y-4 p-5">
        <h2 className="font-medium">A. Claude Code with the Wheelhouse plugin</h2>

        <div className="space-y-2">
          <h3 className="text-sm font-medium">1. Install the plugin</h3>
          <p className="text-sm text-muted">
            <strong className="text-fg">In the VS Code extension</strong>, type {code("/plugins")} (with an s) in the Claude Code prompt box. Do not use{" "}
            {code("/plugin")} there: the extension answers &ldquo;isn&apos;t available in this environment&rdquo;.
          </p>
          <ol className="list-decimal space-y-1 pl-5 text-sm text-muted">
            <li>Open the <strong className="text-fg">Marketplaces</strong> tab and add {code(cmd.marketplace)}.</li>
            <li>On the <strong className="text-fg">Plugins</strong> tab, find <strong className="text-fg">wheelhouse</strong> and click <strong className="text-fg">Install</strong>. Choose <strong className="text-fg">Install for you</strong>.</li>
            <li>A form asks for the server URL ({code(cmd.url)}) and your API key from step 1. The key field is hidden and stored in your OS keychain.</li>
            <li>When it says <strong className="text-fg">Restart Claude to apply plugin changes</strong>, restart.</li>
          </ol>
          <p className="text-sm text-muted">
            Shortcut: <a className="text-accent" href={cmd.vscodeInstallLink}>open the install dialog in VS Code</a>. Nothing installs until you pick a scope.
          </p>
          <p className="pt-1 text-sm text-muted">
            <strong className="text-fg">In a terminal</strong>, start {code("claude")} and run:
          </p>
          <CopyBlock value={cmd.installPlugin} multiline />
          <p className="text-sm text-muted">
            Claude Code then asks for the URL ({code(cmd.url)}) and your key. Either way, you did it right when {code("/mcp")} lists{" "}
            <strong className="text-fg">wheelhouse</strong> as connected. Plugins installed in the terminal and in VS Code share the same settings.
          </p>
        </div>

        <div className="space-y-2">
          <h3 className="text-sm font-medium">2. Link each repository and build the map</h3>
          <p className="text-sm text-muted">In each repository, in Claude Code (VS Code or terminal):</p>
          <CopyBlock value={cmd.linkRepo} />
          <p className="text-sm text-muted">
            This writes {code("wheelhouse.json")} (commit it so teammates share the link) and installs git hooks. It does not ask for the key again.
            Then map the codebase once, so people can understand it without reading it:
          </p>
          <CopyBlock value={cmd.buildMap} multiline />
          <p className="text-sm text-muted">
            Map the schema only if the repo has a database. Later, {code(cmd.refreshMap)} re-describes the parts whose code changed.
          </p>
        </div>

        <div className="rounded-md border border-line bg-bg/40 p-3 text-sm">
          <div className="font-medium">Do I need {code("wheelhouse-cli")}? No.</div>
          <p className="mt-1 text-muted">
            The plugin carries its own copy and runs it for the commands and hooks above, so there is no separate install and no second key to enter.
            You only need Node.js 18+ and git on your machine.
          </p>
          <p className="mt-2 text-muted">
            Optional: git hooks run outside Claude Code and cannot read the keychain. To have commits made outside Claude Code (a terminal, another
            editor) reported too, run this once in a terminal and enter your key when asked:
          </p>
          <div className="mt-2"><CopyBlock value={cmd.loginOptional} /></div>
          <p className="mt-2 text-muted">If you skip it, Wheelhouse still learns what landed at the start of each Claude Code session and at the end of each turn.</p>
        </div>
      </div>

      <div id="setup-mcp" className="card space-y-3 p-5">
        <h2 className="font-medium">B. Claude Code without the plugin</h2>
        <p className="text-sm text-muted">
          Connect Claude Code to Wheelhouse as a plain MCP server. You get the board and map tools; you do <strong className="text-fg">not</strong> get the
          hooks (no automatic briefing, edit tracking or end-of-turn check) or the {code("/wheelhouse:")} commands, and you do not need the CLI. In a
          terminal, run this; it reads the key with the input hidden, so it stays out of your shell history:
        </p>
        <CopyBlock value={cmd.mcp} multiline />
        <p className="text-sm text-muted">
          Add {code("--scope user")} to use it in every project. To share the server with a repo, use {code("--scope project")} and reference the
          variable as {code("${WHEELHOUSE_KEY}")} in {code(".mcp.json")}, so the key never reaches git. Confirm with {code("/mcp")}.
        </p>
        <p className="text-sm text-muted">Without the plugin, the map is built with the MCP server&apos;s own prompts:</p>
        <CopyBlock value={cmd.mcpBuildMap} multiline />
        <p className="text-sm text-muted">
          Later, {code(cmd.mcpRefreshMap)} re-describes the parts whose code changed. Want the hooks too? Use setup A instead.
        </p>
      </div>

      <div id="setup-cli" className="card space-y-3 p-5">
        <h2 className="font-medium">C. Without Claude Code</h2>
        <p className="text-sm text-muted">
          This is the one setup that needs the command line tool. It links a repo and reports commits to the board and map. It asks for your key with
          the input hidden. Needs Node.js 18+ and git.
        </p>
        <CopyBlock value={cmd.cli} multiline />
      </div>
    </>
  );
}
