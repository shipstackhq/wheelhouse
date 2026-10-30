# Hot features

Ideas worth building soon, with where they came from. Not designed yet: each needs a short design before work starts.

## From lfg (2026-10-25)

Source: [lfg](https://github.com/varun-singhh/lfg), an open-source (MIT) local pipeline plugin for Claude Code, released on r/ClaudeCode on
2026-10-25. It is local-only and single-user, so it does not compete with the board, the map or runs; these are the parts of it worth borrowing.

### 1. A guard against risky commands, for the daemon

lfg runs a PreToolUse hook that parses each shell command (segments and heredocs, not just a regex) and blocks pushes, GitHub writes, deploys,
secret reads and destructive deletes, with a self-test (`lfg doctor --selftest`). See `plugin/lib/lfgcore/guard.py` in their repo.

For Wheelhouse: unattended runs on a device rely today on the CLI's allow and deny lists (`runner` in the daemon's `config.json`), which match
command prefixes only. A guard that understands chained commands and flags (for example `git diff --output=<file>`, which the prefix rules
allow) would make runs and chat safer, and a self-test lets people trust it. Lives in the daemon, applies to jobs and chat.

### 2. A record, with undo, of every change the plugin makes to Claude Code config

lfg keeps a ledger of every change it makes to a person's Claude Code settings (hooks, MCP entries, settings files) and can undo each one.

For Wheelhouse: the plugin and `wheelhouse setup` write hooks, MCP config and `wheelhouse.json`. Recording each change and offering
`wheelhouse undo` (or a clean uninstall) is a strong trust story, especially for a paid product people install into their repositories.

### 3. The plugin on per repository, not everywhere

lfg's plugin ships disabled (`defaultEnabled: false`) and is switched on per repository, so its hooks never run in unrelated repos.

For Wheelhouse: the plugin should do nothing in a repository without a `wheelhouse.json` (or a per-repository enable), so installing it once
does not add hooks, briefings or prompts to every project on the machine.

### 4. Hotspots and churn from git history, as a signal on the map

lfg computes hotspots (files that change most), churn, and "why is this here" from git history.

For Wheelhouse: the map already marks nodes stale when their anchored files change. Adding churn and hotspot data per node would show which
parts of the system are risky or in flux, rank stale nodes by how much they matter, and give agents a "be careful here" hint in the briefing.
