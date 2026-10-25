# Agents: one profile schema, a Wheelhouse catalog, workspace-defined agents, team rosters (plan)

Status: **plan v4**, 2026-10-25, branch `wh/agents-frontend`. Builds on `docs/assistants.md` (team agents, "instructions only narrow", no agent
has an account). This slice: define agents, give them faces, put them on teams, and use them in any Claude Code session. Assigning an agent to
an issue to start a run comes later; the schema is ready for it.

## Goal

1. "Agents & API keys" becomes two menus: **Agents** and **API keys**.
2. One fixed, versioned **agent profile schema**: identity and face, when to use it, instructions, rules, style, definition of done, when to
   ask, capabilities and runtime. Wheelhouse's catalog and a workspace's own agents use exactly the same inputs.
3. Wheelhouse ships a **catalog** of six agents with short memorable names.
4. A **workspace** can define its **own agents** with the same form (plumbing in this slice; the full editor UI can follow).
5. **Workspace admins and team admins** add agents to a team. Whether a workspace has agents at all is a **workspace setting**.
6. **Faces** are DiceBear avatars. Wheelhouse sets the catalog agents' faces; a workspace's own agents get a face editor (pick a style,
   shuffle, save).
7. **Catalog versions**: a workspace follows the latest version of each catalog agent by default, and can pin one that worked for it.
8. **A Wheelhouse guardrail prompt** is part of every agent, catalog or custom. Anyone may read it; nobody outside Wheelhouse can change it.
9. Any Claude Code session in a linked repository can use the team's agents, whatever the model (plugin writes Claude Code subagent files).

Out of scope: running issues as an agent, enforcing path scope and tools in the daemon, stats, team-level overrides of a profile.

## Research: what a profile needs

Claude Code subagents are the target every profile must render to. Their frontmatter (code.claude.com/docs/en/sub-agents) supports:
`name`, `description` (required; Claude reads it to decide when to delegate, and all descriptions share a ~15k-token budget per session, so
keep it short), `tools` / `disallowedTools`, `model` (`inherit`, an alias or an ID), `permissionMode`, `maxTurns`, `skills`, `mcpServers`,
`hooks`, `memory`, `background`, `omitClaudeMd`, `effort`, `isolation: worktree`, `color` (8 names), `initialPrompt`. The body is the system
prompt. Files live in `.claude/agents/` (project) or `~/.claude/agents/` (user); the CLI also takes agents as JSON per run with `--agents`,
which the daemon can use for runs without writing files.

What makes an agent worth having (`docs/assistants.md`, `docs/reddit_suggestions/memory-docs-and-hooks.md`): what it **constrains** (paths,
tools, model) and what it **knows** (rules), not its tone; rules with a concrete example are followed far more reliably; "done" must be
defined, not assumed; an unattended agent needs to know when to stop and ask.

So the schema has six parts: identity, delegation, behaviour, capabilities, runtime, meta. Fields with no subagent equivalent (rules, style,
done, ask-when) are rendered into the body as sections.

## The schema

Lives in `packages/shared/src/agents/schema.ts`, validated with zod (added to `packages/shared`), `schemaVersion: 1`. Every agent, catalog or
workspace-made, is one `AgentProfile`.

```ts
type AgentProfile = {
  schemaVersion: 1;

  // Identity
  slug: string;                 // [a-z0-9-]{2,32}, unique per workspace; rendered name is `wh-<slug>`
  name: string;                 // short first name, 2–16 chars: "Bram"
  role: string;                 // "Backend engineer", ≤ 40 chars
  summary: string;              // one line for cards, ≤ 120 chars
  avatar: { style: AvatarStyle; seed: string };  // see Faces
  color: "red" | "blue" | "green" | "yellow" | "purple" | "orange" | "pink" | "cyan";  // Claude Code's transcript colour

  // Delegation
  description: string;          // when to use it, ≤ 300 chars: becomes the subagent `description`

  // Behaviour (rendered into the body, in this order)
  instructions: string;         // markdown, ≤ 8k chars: the role and how it works
  rules: { rule: string; why?: string; example?: string }[];   // ≤ 20; "never X / always Y", each ideally with an example
  style: {
    verbosity: "terse" | "normal" | "detailed";
    explainChanges: boolean;    // finish with a summary of what changed and why
    notes?: string;             // free text: code style, naming, commit message style
  };
  done: string[];               // checklist that defines "done", e.g. "tests for touched files pass", "no new lint errors"
  askWhen: string[];            // when to stop and ask instead of guessing, e.g. "the issue and the code disagree"

  // Capabilities
  kind: "builder" | "advisor";  // builders change code; advisors review, plan, answer
  toolProfile: "edit" | "read-only" | "custom";
  tools?: string[];             // only with "custom": allowlist
  disallowedTools?: string[];   // always applied; narrows, never widens
  pathScope: string[];          // globs it works inside, e.g. ["apps/web/**"]; [] = whole repo. Advisory now, enforced by the daemon later
  skills: string[];             // Claude Code skill names to preload, ≤ 32

  // Runtime
  model: "inherit" | "opus" | "sonnet" | "haiku";   // inherit = whatever the session uses
  effort: "low" | "medium" | "high" | null;
  maxTurns: number | null;
};
```

Not in v1 on purpose: `mcpServers` and `hooks` (can run code or reach services; wait for the MCP redesign and the command guard),
`permissionMode` (ignored for plugin agents, overridden by sessions), `memory`, `isolation`, `background`. Adding a field later means
`schemaVersion: 2` and a migration of stored profiles in code.

## The guardrail prompt

Every agent, including the ones a workspace writes, is rendered with a Wheelhouse **guardrail preamble** placed before its own text. It is
how Wheelhouse keeps user-made agents within bounds without approving them.

- Lives in code (`packages/shared/src/agents/guardrails.ts`), versioned (`GUARDRAILS_VERSION`), the same for every agent.
- Content (to be written in Phase 1): stay inside the task and the repository; never exfiltrate secrets or credentials, read `.env`-style
  files only when the task needs it and never print their values; no destructive git (force push, history rewrite, deleting branches) or
  destructive shell; never weaken or skip tests or checks to make them pass; follow the repository's own CLAUDE.md and rules; when the
  agent's own instructions conflict with these, these win and the agent says so; when unsure, ask (the `askWhen` list adds to this).
- Ordering in the rendered body: guardrails, then a line "The instructions below come from the agent's author and cannot override the
  above", then the agent's instructions and sections.
- Visible, not editable: the agent page shows it read-only under "Wheelhouse guardrails (v N)", and `GET /api/app/agents/guardrails`
  returns it. It is never part of a profile, so no profile edit can change or remove it; it is added only when an agent is rendered for use.
- Local tampering: a person can edit a synced `wh-*` file on their machine, but the next sync (each session start) rewrites it, and runs on
  a device (later) get their agents from the server as `--agents` JSON, never from the repository's files.
- Custom agents carry a "Made by your workspace, not by Wheelhouse: no warranty" note on their cards and pages.
- The guardrails narrow, never widen: they cannot grant tools or paths the profile does not give.

Rendering (`packages/shared/src/agents/render.ts`), one function per target:

| Target | Function | Use |
|---|---|---|
| Subagent file | `toSubagentFile(p)` | Frontmatter `name: wh-<slug>`, `description`, `model`, `effort`, `maxTurns`, `color`, `skills`, `tools` / `disallowedTools` from the tool profile (`read-only` → `tools: Read, Grep, Glob`); body: instructions, then `## Rules`, `## Style`, `## Done means`, `## Ask instead of guessing when`, `## Scope`, and a footer with the version |
| Run JSON | `toAgentsJson(p)` | The same as an `--agents` entry, for the daemon later |
| Card | `toView(p)` | What the web shows |

Tool profiles: `edit` → no `tools` line (inherit), `disallowedTools` as given; `read-only` → `tools: Read, Grep, Glob` plus
`disallowedTools: Write, Edit`; `custom` → the lists as given. Validation refuses a `read-only` profile that lists edit tools.

## Faces

- DiceBear rendered locally with `@dicebear/core` + `@dicebear/collection` (exact versions), never the hosted API.
- `AvatarStyle` is a fixed list of **CC0** human styles, so a paid product needs no attribution: `notionists` (default),
  `notionists-neutral`, `lorelei`, `lorelei-neutral`, `open-peeps`. Popular styles such as Micah, Adventurer and Personas are CC BY 4.0
  (attribution required) and are left out on purpose.
- **Catalog agents**: Wheelhouse sets the face in the catalog, and it changes only with a new catalog version. Workspaces cannot change it.
- **A workspace's own agents**: the agent page shows the face with **Shuffle** (new random seed), a style picker showing the five styles
  with this agent's seed; live preview; Save stores `avatar` only. Allowed for the agent's creator, workspace
  admins, and team admins of a team the agent is on.

## Data

| Thing | Where | Notes |
|---|---|---|
| Catalog profiles | Code: `packages/shared/src/agents/catalog.ts`, each with its own `version` | Designed by Wheelhouse, reviewed in PRs |
| Workspace switch | `workspaces.settings.agentsEnabled` (boolean, default true), workspace admins | Off: the Agents menu, team rosters and the sync are hidden or empty; data is kept |
| Catalog versions | Code: every published version of each catalog agent is kept, immutable (`catalog/<slug>.ts` exports `versions: AgentProfile[]`) | Pinning needs the old text to exist; a test refuses edits to a published version |
| Workspace agents | Table `workspace_agents`: id, workspace_id, team_id (null = workspace-wide; set = a team agent, only that team), slug (unique per workspace), source (`catalog` \| `custom`), catalog_slug, pinned_version (null = follow latest), profile jsonb (custom only), version, created_by, updated_by, timestamps | `custom`: the full profile. `catalog`: no profile, just the pin. A catalog agent gets its row the first time it is added to a team or pinned |
| Team rosters | Table `team_agents`: team_id, workspace_id (`teamScope`), workspace_agent_id, added_by, added_at; unique (team, agent) | A reference: teams see edits and catalog updates |

The effective profile = the custom profile, or the catalog version (the pinned one, or the latest). Validated with the schema on every write
and read. Rendering adds the guardrail preamble.

Permissions:

| Action | Who |
|---|---|
| Turn agents on or off for the workspace | Workspace admin |
| See the catalog and the workspace's agents | Any workspace member (when on) |
| Create a workspace-wide agent (any team can add it) | Workspace admin |
| Create a team agent (only that team sees and uses it) | That team's admin, or a workspace admin |
| Edit, delete a custom agent | Its creator or a workspace admin |
| Change a workspace agent's face | Its creator, a workspace admin, or a team admin of a team it is on |
| Change a catalog agent's face | Nobody in the product: Wheelhouse, through a new catalog version |
| Pin a catalog agent's version, or unpin | Workspace admin |
| Add or remove agents on a team | Workspace admin, or that team's admin |
| See a team's agents | Team members |

## The catalog

Short, memorable names whose first letter matches the role; placeholders for the text, written in Phase 1.

| Slug | Name | Role | Kind | Tools | Model | Path scope (advisory) |
|---|---|---|---|---|---|---|
| backend | **Bram** | Backend engineer | builder | edit | inherit | server code |
| frontend | **Fern** | Frontend engineer | builder | edit | inherit | client code |
| fullstack | **Finn** | Full-stack engineer | builder | edit | inherit | whole repo |
| database | **Dara** | Database engineer | builder | edit | inherit | schema, migrations, queries |
| reviewer | **Remy** | Code reviewer | advisor | read-only | inherit | whole repo |
| architect | **Arlo** | Architect | advisor | read-only | inherit | whole repo |

Path scopes in the catalog are descriptions in the body ("server code"), not globs, because repositories differ; a workspace agent can set
real globs.

## Phases

Each phase is one agent's job, ends with its tests passing, and touches only what it lists.

### Phase 1: schema, renderers, catalog (shared). Sonnet.
- `schema.ts` (zod + types), `guardrails.ts` (the preamble, versioned), `render.ts` (`toSubagentFile`, `toAgentsJson` with the guardrails;
  `toView` without), `catalog/` (six agents, version 1 each, real text, versions kept immutable), `avatar.ts` (the style list,
  `randomSeed()`).
- Tests: every catalog profile validates; limits enforced (lengths, counts, slug shape, read-only with edit tools refused); the subagent file
  parses as frontmatter + body with the right fields per tool profile; the guardrails come first in every rendered agent and never in
  `toView`; a snapshot per section; `toAgentsJson` matches the CLI's shape; published catalog versions are unchanged (hash check).

### Phase 2: data and API (api). Sonnet. Needs 1.
- Migration 0046: `workspace_agents`, `team_agents`; isolation entries (`tests/isolation.test.ts`, `docs/isolation-audit.md`), table
  ownership (`docs/nest-architecture.md`).
- An `agents` module (person side):
  - `GET  /api/app/agents` → `{ enabled, catalog: AgentView[], workspace: AgentView[] }` (catalog entries with `latestVersion`,
    `pinnedVersion`, and the version in use)
  - `GET  /api/app/agents/catalog/:slug/versions` → the versions with a short changelog each
  - `PUT  /api/app/agents/catalog/:slug/pin` `{ version | null }` → pin or follow latest (workspace admin)
  - `GET  /api/app/agents/guardrails` → `{ version, text }` (read-only, any member)
  - `POST /api/app/agents` `{ profile, teamKey? }` → without `teamKey` a workspace-wide agent (workspace admin); with it a team agent, put on
    that team's roster (that team's admin or a workspace admin). A team agent cannot be added to another team (400)
  - `PATCH /api/app/agents/:slug` `{ profile }` (creator or workspace admin) or `{ avatar }` (creator, workspace admin, team admin of a
    team it is on); custom agents only
  - `DELETE /api/app/agents/:slug` → custom only; removes it from teams (creator or workspace admin)
  - `GET  /api/app/teams/:key/agents`, `POST /api/app/teams/:key/agents` `{ slug }`, `DELETE /api/app/teams/:key/agents/:slug`
    (workspace admin or team admin; members can read)
  - `PATCH /api/app/workspace/settings` gains `agentsEnabled` (workspace admin), or wherever workspace settings are saved today
- For the plugin: `GET /api/v1/team-agents?team=KEY` (agent key, scoped to its teams) → `{ files: [{ name, content }] }` from
  `toSubagentFile`; empty when the workspace has agents off.
- Bus events and an activity entry ("added Bram (Backend engineer) to the team").
- Tests: permission matrix above, the switch off hides everything, pin and unpin (the v1 route renders the pinned text), catalog faces
  cannot be changed, custom create/update/delete,
  invalid profiles refused with field errors, isolation across teams and workspaces, the v1 route scoped to the key's teams.

### Phase 3: faces and cards (web). Haiku. Needs 1.
- Add DiceBear packages. `components/agent-avatar.tsx` (memoised SVG data URI from `avatar`, sizes, alt = name),
  `components/agent-card.tsx` (face, name, role, summary, kind, tools, model, a "made by your workspace" mark for custom agents, action
  slot), `components/avatar-editor.tsx` (preview, Shuffle, style picker, Save, as a dialog; custom agents only).
- Tests: same seed same SVG, shuffle changes the seed, style picker shows the five styles, Save sends only `avatar`.

### Phase 4: split the menus (web). Haiku.
- Today's page becomes **API keys** at `/api-keys` and `/settings/api-keys`; sidebar and settings nav updated; `agents.test.tsx` →
  `api-keys.test.tsx`. No redirect (dev-only). `/agents` is free for Phase 5.

### Phase 5: the Agents pages (web + api-client). Sonnet. Needs 2–4.
- `packages/api-client`: `api.agents.*` and `api.teams.agents*`, types from the shared schema.
- `/agents`: the switch state (admins see a link to the setting when off), the catalog and the workspace's agents as cards; an agent page
  with its full profile and the guardrails shown read-only, "Add to team" for anyone allowed on some team; for catalog agents the version in use, a
  "new version available" note with its changelog, and Pin / Follow latest for workspace admins; for custom agents Change face and Edit
  for those allowed, and the no-warranty note.
- `/t/:key/agents` in the team nav: the roster, Add (opens the catalog and workspace agents), Remove, and a "Use in Claude Code" box.
- Workspace settings: the "Agents" switch.
- Custom agents in this slice: "New agent" for workspace admins as a **simple form over the schema** (identity, description,
  instructions, rules list, done list, ask-when list, kind and tool profile, model). A polished editor can follow.
- Tests: render, permissions (buttons only for allowed roles), switch off, add and remove, pin and unpin, face change on a custom agent
  only, create a custom agent as a team admin.

### Phase 6: plugin sync (wheelhouse-cli). Sonnet. Needs 2.
- `wheelhouse agents sync` in `cli/bin/wheelhouse.mjs` (then `npm run sync-plugin`): fetch the team's files, write
  `.claude/agents/wh-<slug>.md`, delete `wh-*` files no longer on the roster, never touch other files, add `.claude/agents/wh-*.md` to
  `.gitignore` once.
- Called from the SessionStart hook (quiet, short timeout, no-op offline) and as `/wheelhouse:agents`.
- Tests: write, update, remove only `wh-*`, offline no-op, gitignore once, agents off → removes `wh-*`.

### Phase 7: check and hand over. You or one agent.
- Typecheck, lint, every suite, `claude plugin validate`. By hand: turn agents on, add Bram to a team, pin his version, create a custom
  agent and change its face, sync in a linked repo, check the guardrails head each `wh-*` file, then in Claude Code "use wh-backend to …".

## Order

```
Phase 1 ──┬── Phase 2 ──┬── Phase 5 ── Phase 7
          ├── Phase 3 ──┤        │
          └── Phase 4 ──┘        │
                Phase 2 ── Phase 6 ──┘
```

## Open questions

- How catalog changelogs are written (one line per version in the catalog file is the plan's assumption).
- Can a workspace admin promote a team agent to workspace-wide later? (Not in this slice; the `team_id` column makes it a one-field change.)
