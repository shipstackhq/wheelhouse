# Assistants: named agents for a team, and the recommender that picks one (design)

Status: **design, nothing here is built.** What exists today is "Run on device" (`lib/daemon.ts`: `runOnDevice`, `finishJob`, `openJobPullRequest`) and the daemon in the `wheelhouse-cli` repo (`daemon/`). This note says where assistants go on top of that and what is still open.

## The idea

An assistant is a named, reusable **template for a run**, not a process. A team gets a few ready-made ones (Backend, Frontend, Full Stack, Database; later Architect and UI Designer) and can edit them or add its own. Assigning an issue to an assistant starts a run, on the requester's device, exactly as "Run on device" does now. Nothing runs between runs.

The pitch is that they feel like assistants working alongside a solo developer or a small team:

- **No agent has an account.** Commits and the pull request belong to the person who asked for the run. The assistant is credited as co-author (`Co-authored-by:`), and the run record says which assistant, model and device did the work.
- The person who delegates is responsible for the result, as an assignee is for an issue Linear's agent works on.

A template with only a role and a tone is worth little: `CLAUDE.md` in the repo already carries most of that. An assistant earns its place through what it **constrains** and what it **learns**:

| Part | What it does |
|---|---|
| Instructions | A short role and guardrails, layered on the repo's own `CLAUDE.md` |
| Default model | Opus for the Architect, Sonnet or Haiku for routine work: real cost control |
| Path scope | Frontend touches `apps/web`, Database touches the schema and migrations: the main defence against the wrong agent changing the wrong thing |
| Tool profile | Edit, or read-only for investigations and reviews |
| Context (later) | Which map nodes, docs and ADRs it starts with |
| Playbook (later) | Lessons from review feedback that the team approved |

## How it sits on "Run on device"

A run today is *(issue, device, repository, model)*. It becomes *(issue, assistant, device, repository)*; the assistant supplies the model default, instructions, scope and tools.

- **Data:** a `team_agents` table (team, name, slug, role, avatar, instructions, default model, kind, path scope, tool profile, enabled, version, template id). Starter assistants are templates that "Deploy to team" copies in, where an admin edits them. A custom assistant is the same table without a template.
- **The offer:** the signed `job.offer` gains an `agent` block. The daemon's runner already builds the prompt (`daemon/src/runner/claude.mjs`), so the instructions go in there.
- **The run:** `device_jobs` records `agent_id` and a **snapshot** of the instructions it ran with, so a run can be audited after the assistant is edited.
- **Instructions only narrow.** The daemon's local allow and deny lists (no `git push`, `curl`, `sudo`, …) always win. An assistant can restrict what a run may do, never widen it.
- **Naming:** the existing API keys page is about outside agents that connect by key. Assistants need their own name in the UI ("Team agents") so the two are not confused.

## Two kinds

- **Builders** (Backend, Frontend, Full Stack, Database) end in a branch and a pull request. This is the current run ending.
- **Advisors** (Architect, UI Designer) end in a plan, a comment or a doc. They need a second kind of ending, and anything that creates sub-issues needs board write access, which waits for the MCP redesign (runs are `boardAccess: none` until then).

First version: **builders only.**

## Handing over: "done" is defined once

Delegated runs are unattended, so the checks a person does by watching have to be part of the run.

1. After the agent finishes, the **daemon** runs the repository's configured commands (tests, typecheck, lint) in the worktree.
2. On failure it resumes the agent's session with the failure output, a bounded number of times.
3. It pushes and reports a structured result (`ran`, `passed`, `failures`, what was left untouched, what it was unsure about).
4. The server puts that in the pull request description (`openJobPullRequest` already builds the body).

Where the commands live is open: per repository on the server, or in the `wheelhouse.json` that repositories already carry.

The same contract should hold for interactive sessions: the plugin's **Stop hook** ("what does this session owe?") is the in-IDE version. Define "done" once on the server, per team or repository, and each runner (IDE hook, daemon, a later sandbox) enforces it.

Security: these commands run repo scripts the agent may have just edited, outside the agent's restricted tools. Run them in the worktree with a timeout and no extra credentials.

After the pull request, the same assistant should be able to continue on the same branch when a reviewer comments or a check fails (the server already receives check results). That is a new run on the existing branch, offered to the person with the failure as its brief.

## Measuring whether it helps

The aim is less human attention per merged change. Most of these come from data we already keep:

| Stat | From | Tells you |
|---|---|---|
| Merge rate (runs whose PR merged) | PR state, linked to the run by branch | Whether the work is useful |
| Rework (human commits after the run's, review rounds) | Commits with and without the run trailer | How much people correct |
| Cost per merged PR | `costUsd` on runs | Whether it is worth it |
| Issue → PR and PR → merge time | Issue and PR events | Cycle time |
| Failure reasons | Run results | Where the friction is |
| Human touches per PR | PR comments and commits | The attention measure |

- **Commit trailers are required**, not optional: commits are authored by the person, so `Co-authored-by` and `Wheelhouse-Run` / `Wheelhouse-Runner` trailers are the only way to tell an assistant's commits from a person's edits later.
- Small teams give noisy data. Per-assistant outcomes (merge rate, rework, cost) are credible; claims about team velocity are not. Read merge rate next to rework, since easy tickets inflate it.
- Guard against more pull requests than people can review: features should lower the effort of reviewing each one, not only raise output.

## The recommender (the "triage layer" for execution)

A recommender over the assign button, not an agent. It ranks *(assistant, model, device)* for one issue given a preference, and the person confirms.

**Inputs**

- The requester's online devices, free slots and the models each offers (from the daemon's hello), and whether the pool is paused after a usage limit.
- The team's enabled assistants, matched to the issue's labels and the area of the code.
- Run history: which combinations ended in merged PRs with little rework, on what kind of issue.

It works only across the requester's own devices and subscription. Other people's machines are out of scope until shared runners exist.

**The preference.** On an own subscription the marginal dollar is near zero; the scarce thing is usage-limit headroom. So:

| Preset | Behaviour |
|---|---|
| Save quota | The smallest model that has done similar work well, on the device with the most headroom |
| Balanced | Default |
| Best quality | The strongest model, whatever it uses |
| Fastest | The idle device that can start now |

**Behaviour**

- Recommend, then ask: "Ada · Sonnet on Laptop, small change, about 10 minutes", one click to confirm, easy to override. Auto-assign without confirmation can come later as a team setting.
- One line of reason with every pick. The override rate is the recommender's own quality metric.
- A third outcome besides the options: **not ready** ("needs a human", "unclear: ask for X first"), so a vague ticket does not burn a run.
- Linear's triage suggests a human assignee, team and labels. This chooses who *executes*, which is a different job.

**Build order**

1. Rules only: devices, models, preset, labels and a rough size guess (description length, area). No model call.
2. A small model (Haiku) classifies complexity and area and checks readiness. The only place an LLM is needed.
3. Learn from outcomes, once there are enough runs to say anything. Until then show ranges and say when unsure.

With one or two devices and three assistants the choice is nearly trivial; the value grows with the options. Do not build the learning part first.

## Order of work

1. Run trailers and the per-user GitHub link (pull requests opened as the requester; without a link, push the branch and give the person a link to open it, not a bot-authored PR). Today `openJobPullRequest` opens it as the App.
2. Verify before handoff, with the structured result in the pull request.
3. Follow-up runs on review comments and failing checks.
4. `team_agents`, the assign flow, the badge on board cards.
5. Per-assistant stats.
6. The recommender, in the three steps above.
7. Lessons from review feedback; advisors after the MCP redesign.

## Open questions

- Where the verify commands are configured (server per repository, or `wheelhouse.json`).
- Whether Anthropic's terms allow running the user's own subscription this way (an open item in the daemon's `DESIGN.md`). The cost story depends on it.
- Whether a second runner (the Codex CLI) is worth adding for people who want to use another subscription. A Linear user asked for exactly that.
- Whether the sandbox, when it exists, commits as the requester through the same connected GitHub account.
- Assistants per team or per workspace.
