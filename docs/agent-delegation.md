# Agent delegation

Status: plan. We build this next.

## Goal

Agents (the catalog and custom profiles in [agents-plan.md](agents-plan.md)) are profiles today; nothing uses them. Runs ignore them and every run is the same generic Claude. This plan puts agents in the work loop: a person delegates an issue to an agent, and the agent's profile shapes the run.

## The model

- **Issues are assigned to humans only.** The assignee owns the issue.
- **A human delegates to an agent.** The issue gets a `delegate` (an agent) next to its assignee.
- **A run is one attempt.** Delegating starts a run; one delegation can produce several runs (retries, reruns).
- **The requester owns the run.** The requester is whoever started that run. Usually it is the assignee, but it doesn't have to be.

| Role | Owns | Is |
|---|---|---|
| Assignee | the issue | a human |
| Delegate | doing the work | an agent |
| Requester | one run | the human who started it |

## Who can delegate

The assignee, or a workspace or team admin.

When someone other than the assignee starts a run (say an admin delegates on Bob's issue):
- the admin is the requester for that run;
- Bob stays the assignee and gets one ping: "Admin asked Remy to work on ENG-42";
- Bob can stop the run, or rerun it himself, which makes him the requester;
- Bob is also pinged when the run finishes.

## The requester

- Gets the agent's questions in their inbox first.
- The PR is opened as the requester, with the Wheelhouse bot as co-author (the current attribution rule).
- The run uses the requester's permissions. An agent can never do what the requester couldn't.
- If the requester leaves the team or workspace, the active run stops and the delegate is cleared.

## Starting a run

Both entry points create the same run:

1. **Delegate:** set the issue's delegate. This starts a run on the requester's default device.
2. **Run on device:** an override from the issue's ⋯ menu, for rerunning or picking another device. Uses the delegate's profile if there is one, otherwise it is a generic run.

If no device is online, the run is queued and the issue says "Waiting for a device".

## The pipeline (both entry points)

```
run (queued) → daemon claims job → fresh worktree on wh/<issue> branch
  → Claude launched with: guardrails + agent profile + team learnings + issue + MCP key
  → logs stream to the run
  → done: push, open PR as the requester, issue → In Review
  → askWhen hit: comment on the issue, run → blocked
  → failure: run → failed, with logs
  → end: may propose learnings; the run joins the agent's history
```

Rules:
- One active run per issue. A new run replaces the old one (the existing supersede).
- Clearing the delegate stops the active run.
- A failed run leaves the delegate in place, so Rerun is one click.
- The profile's `done` list is checked before the run calls itself finished.
- An `askWhen` case makes the agent ask a question instead of guessing.

## Where the agent talks

- **The issue thread** is where its work stays.
  - One comment per run: a summary and a verdict, with details folded.
  - No running chatter.
- **Questions** are comments on the issue, so anyone on the team can answer, not only the requester.
- **The inbox points at them.** The requester is pinged ("Remy has a question on ENG-42"), and can reply inline from the inbox for quick answers. The reply posts as a comment on the issue.
  - Answering clears the inbox item and the card's dot.
- **Notifications:** only for a question and for work being done. Nothing for "started" or for individual steps.
- **No DMs** for now. Something private (say a secret in a diff) is the only case for them, and it is rare enough to leave out.

## History and learnings

- **History:** the agent's runs, filtered by agent: issue, PR, summary, requester, outcome. It's for people (trust and audit) and is never put in the prompt.
- **Learnings:** short notes, scoped to a team, that the agent proposes at the end of a run ("This team keeps tests next to source").
  - Capped at around 20 per team and agent.
  - Humans can edit and delete them.
  - Loaded into every run for that team.
  - Never raw transcripts, and nothing from another team.
- Most of what an agent should know is already in the code, the map and the decisions. Learnings are only for what's left: the team's taste and corrections.

## UX

It should feel like handing work to a fast teammate, not like operating CI.

- **Delegating:** a Delegate picker next to the assignee lists agents with avatar and role ("Remy · Reviewer"). Picking one is the whole action. A quiet line underneath says "Runs on your Mac" and can be clicked to change the device.
- **The card:** shows the assignee's avatar with a small agent badge while a run is active.
  - One line of what the agent is doing now, no spinners.
  - "Remy has a question" is an accent dot; it is the only loud state.
  - When the run finishes, the card moves to In Review with a PR chip.
- **The issue:** the run shows in activity like a teammate's comments. Logs are behind "View run", collapsed. The ⋯ menu has Stop, Rerun and Run elsewhere.
- **The agent's page:** avatar, role and description, then Recent work (history), Learnings (editable) and Teams.

## What exists

Devices, jobs, worktrees, supersede, opening PRs as the user, agent profiles, rosters, guardrails, the inbox.

## What's new

1. An issue `delegate` (an agent slug from the team's roster) and who may set it.
2. An `agentSlug` and `requesterId` on the run, and the profile in the job payload.
3. The daemon launches Claude with the profile (instructions, rules, tools, path scope) and honours `done` and `askWhen`.
4. Setting the delegate starts a run; clearing it stops the run. A queue for when no device is online.
5. Agent questions as issue comments plus an inbox item, with an inline reply that posts to the issue.
6. One summary comment per run.
7. The agent history page (runs filtered by agent).

Later, not in the first phase:
- Learnings
- Reviewer runs started automatically on each PR
- Suggesting an agent from labels or paths
- Sandboxes (see [environments.md](environments.md))

## Open questions

- Does a reviewer agent need its own trigger (a PR opened), or is delegating a review issue enough for v1?
- Default device when the requester has several online: the last used, or a chosen default?
- Should a run's summary comment be editable by the requester?
