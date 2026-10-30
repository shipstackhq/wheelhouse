# The night shift: autonomous runs for solo devs and small teams (research)

Status: **research, nothing here is built**, 2026-10-25. Builds on runs on device (`wheelhouse-cli/daemon/DESIGN.md`), chat (`docs/chat.md`),
assistants and the recommender (`docs/assistants.md`) and the map. Prompted by Reddit feedback on the first post (below).

## The angle

> Plan with your agent by day. Your machine works the backlog while you sleep. You wake up to pull requests, not prompts.

Who it is for: one developer, or a team of two to five, who already lives in Claude Code and has more tickets than hours. Their bottleneck is
not typing speed; it is their own attention. Every hour they spend watching a session is an hour they are not deciding, reviewing or resting.

Why Wheelhouse, and not the alternatives:

| Option | What it lacks for this person |
|---|---|
| A long Claude Code session or a shell loop | No queue, no memory between tickets, no idea which tickets can run together, nothing to review in the morning except a terminal |
| Cloud coding agents (sandboxes) | They rebuild the person's setup in a sandbox, bill compute per task, and miss the local hooks, keys and tools. The Reddit commenter: "my sessions need my local setup, my hooks and my keys, and a sandbox would mean rebuilding all of it" |
| Local pipelines (for example lfg) | Interactive and single-session: excellent gates, but a human drives each run. No queue, no overnight work |
| Wheelhouse | The queue, the plans, the memory (map, decisions, briefing) and the review surface live in Wheelhouse; the work runs on the person's own machine, with their own subscription and setup |

So the pitch to a solo dev is not "a board". It is **a night shift**: Wheelhouse decides what can safely run, in what order, on which model,
and hands back reviewed-ready PRs with an inbox that says what needs you.

## What the Reddit feedback says

From the first post (2026-10-25), one detailed commenter who built "runs on my own machine" for themselves:

1. **Runs on your own machine are the part used every day**; "the board is just whatever tracker I already had". Lead with runs, not the board.
2. **Own machine, own setup.** They need their hooks and keys. Our runs use `claude --restricted`, which ignores them. Needs a per-repo opt-in.
3. **The pain is re-explaining and slightly-off results**, not waiting. What helped: **the agent writes back what it will do, the person
   approves, and only the approved version becomes the ticket**. "The run itself just executes it."
4. **Conflicts: one run at a time per repo, in blocked-by order.** "Slower, but I'm asleep anyway."

Point 4 is the honest baseline: serial runs need no prediction at all. Parallel runs are a speed-up on top, worth it only if picking safe
pairs is cheap and right.

## The loop

```
 day                                   night (daemon)                          morning
 ─────────────────────────────────    ────────────────────────────────────    ───────────────────────
 chat about the work (read-only)       take the next ready issue                inbox: "3 PRs ready,
 agent writes the plan                 check its footprint against running        1 asks a question,
   (steps, files it expects to touch)    runs → start, or wait                    1 failed"
 person approves → issue "Ready"       pick the model                           review the PRs
   with the plan + footprint           run → verify (tests) → push → PR         merge, or comment →
                                       next one; pause on usage limit             a follow-up run
```

### 1. Plan first, in the chat (day)

The chat already reads the code, read-only, on the person's machine: the right place to plan. Add an "approve plan" step:

- The person talks the issue through; the agent answers with a plan in a fixed shape: goal, steps, **files it expects to change**, files it
  expects to read, checks to run, open questions.
- "Approve" turns the plan into the issue (or attaches it to an existing one) and marks it **Ready for a run**. Unanswered questions block it.
- The run gets the approved plan as its brief ("execute this, do not redesign"), which addresses "slightly off" results.
- The plan's file list is the **footprint seed**, produced at no extra LLM cost because the plan was being written anyway.

### 2. Footprints: which files a run will touch, cheaply

Goal: before starting a run, know with fair confidence which files it will change, so two runs that would collide are not started together.
Mostly without an LLM.

Two sets per issue:

- **Seeds**: files it will likely edit.
- **Reach**: files those seeds pull in or are pulled in by (one or two hops in the import or call graph): may need changes, or may break.

Sources for seeds, cheapest first:

| Source | Cost | Note |
|---|---|---|
| The approved plan's "files to change" | Free (already written) | Best signal when the plan-first step is used |
| Map nodes linked to the issue → their anchors | Free (a query) | Issues already link to map nodes; anchors are path globs |
| Identifiers and paths named in the issue text, matched against the code graph's symbol names | Free (string match) | Catches "fix `finishJob`" style tickets |
| A Haiku call over the issue plus the map's node summaries (not the code): "which 3–5 areas?" | Small | Only when the above find nothing |

Expanding seeds to reach is the code graph's job. Two existing tools fit (both build from tree-sitter, no LLM or API key for code):

| | code-review-graph | graphify |
|---|---|---|
| Builds | Functions, classes, imports; calls, inheritance, tests-for edges, in one SQLite file | A concept graph with communities and "god nodes", as `graph.json` |
| Useful queries | Impact radius (callers, dependents, tests of a change), importers of, callers of | `query`, `path A B`, `explain` |
| Speed | ~40 s cold for ~3,000 files; ~2.5 s after a two-file change (incremental by file hash) | Not published |
| License | MIT | Apache-2.0 |
| Fit | **Footprints**: impact radius is exactly "reach" | **The map**: communities and concepts could seed the system and concept layers |

Recommendation: **code-review-graph for footprints**; keep graphify in mind as a way to draft the map for a new repository. Both are Python;
the daemon is Node, so either ship them as an optional install the daemon calls, or start with a small file-level import graph in Node
(imports alone are enough to compare footprints at file level). The graph is built on the device, on the daemon's existing clone, at the
run's base commit, so no code leaves the machine.

Conflict rule:

- **Hard**: two runs' seeds overlap → never run together; the later one waits (blocked-by order first, then priority).
- **Soft**: one run's seeds are in the other's reach → may run together, but the second PR is flagged "check against #N".
- **Always hard: hot files** every feature touches: lockfiles, `package.json`, the migration journal and its numbering, generated
  snapshots, the router, the schema index. In this repository two parallel runs that each add a Drizzle migration would both pick `0045`:
  no file overlap a graph would see, a guaranteed conflict. A per-repo hot-file list (with sensible defaults per stack) catches these.

Measure it: after each run, compare predicted seeds and reach with the actual diff. Precision and recall per repo tell us whether
parallel runs are safe there, and the actual diffs feed churn and hotspot data back to the map (see `docs/hot-features.md`, item 4).

Start without the graph: plan files + map anchors + hot files + serial-on-overlap. Add the graph only if footprints miss too often.

### 3. The scheduler on the device (night)

The daemon already has a pool, offers, cancel, continuation and a usage-limit pause. The night shift adds a queue it pulls from:

- **Ready queue**: issues marked Ready (approved plan, no open questions), in blocked-by order, then priority.
- **Lanes**: start a run only if its footprint has no hard conflict with running ones; otherwise take the next ready issue that fits.
- **Model choice**: rules first (`docs/assistants.md`, recommender step 1): plan size, files in the footprint, labels → Haiku, Sonnet or Opus.
  The person sets a preference (save quota, balanced, best quality) for the night.
- **Usage limits**: the subscription's limit is shared by every run. On a limit, pause the whole queue until the reset, then carry on; never
  burn the limit on retries.
- **Verify before PR**: run the repository's checks in the worktree, feed failures back a bounded number of times (assistants.md, "Handing over").
- **Stop rules**: a nightly budget (runs, hours or cost), a per-run time limit (exists), and "stop the queue after N failures in a row".
- **Power**: a sleeping laptop stops everything. The daemon can keep the Mac awake while the queue has work (`caffeinate -i` for the run's
  lifetime) and say so in the morning report.

Board writes stay with Wheelhouse: status changes come from run state, not from the agent (until the MCP redesign).

### 4. The morning inbox

The inbox already exists. The night shift adds:

- One digest: "Overnight: 3 PRs ready for review, 1 needs an answer, 1 failed (tests), 2 still queued (usage limit reached at 04:10)."
- One item per PR awaiting review, linked to its issue, its plan and the run log, with the verify result and any soft-conflict flag.
- Questions an agent could not answer become comments on the issue, and the issue goes back to "needs input", not into a guess.

## What exists, what is missing

| Piece | State |
|---|---|
| Runs on device: worktrees, branches, PRs as the person, cancel, continue | Built |
| Pool size, usage-limit pause, heartbeats, lost or unreachable runs | Built |
| Chat on device, read-only, branches and models | Built (first slice) |
| Inbox and notifications | Built |
| Map nodes with file anchors, issue ↔ node links | Built |
| **Blocked-by links between issues** | **Missing**: the issues schema has no relations. Needed for ordering |
| Plan in a fixed shape, approve → Ready | Missing |
| Footprints, hot-file list, conflict check | Missing |
| A queue the daemon pulls from (instead of one offer per click) | Missing |
| Verify before PR, follow-up runs on review comments | Designed in `docs/assistants.md`, not built |
| Model choice rules | Designed, not built |
| "Use my local setup" opt-in for runs | Missing (runs are `--restricted`) |
| Morning digest | Missing (the inbox is there) |

## Suggested order

1. **Blocked-by links** on issues, and a serial night queue per repository (the commenter's setup). Useful on its own.
2. **Plan first** in the chat: the fixed plan shape, approve → Ready, the plan as the run's brief.
3. **Verify before PR** and the morning digest.
4. **Footprints without a graph** (plan files, map anchors, hot files) and two lanes per repository, measured against real diffs.
5. Model choice rules and the nightly budget.
6. The code graph, only if footprints miss too often.

## Open questions

- Anthropic's terms for unattended runs on a Pro or Max subscription (already open in the daemon's `DESIGN.md`). A night shift is exactly the
  "volume" gray area, so this needs an answer before it is marketed.
- Two PRs that pass alone can still conflict at merge. Should the second run rebase and re-verify when the first merges?
- How much review the morning can take: a cap on PRs per night, and smaller PRs, may matter more than more runs.
- Whether "use my local setup" is safe enough with the command guard (`docs/hot-features.md`, item 1) in front of it.
