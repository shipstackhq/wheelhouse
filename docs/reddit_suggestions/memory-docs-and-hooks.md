# Memory, docs and hooks: lessons from r/ClaudeCode

Source: the r/ClaudeCode post "My Claude Code setup: it runs like a small engineering team with guardrails" and its comments (October 2026).

## Lessons for Wheelhouse docs

1. **Short entry file, detail elsewhere.** The author keeps CLAUDE.md short and pointing to detail. Wheelhouse should generate a small project brief for agents (what the project is, current priorities, rules) that links to the full docs, rather than loading everything into context.
2. **One fact per entry, typed.** Separate kinds: decisions, rules, references, project state, and "traps" (things that cost hours once). Types make it possible to show agents only what's relevant.
3. **Freshness on anything that ages.** A `stale_after` date or a "check again" trigger on versions, owners, IPs and prices, with stale items flagged before anyone relies on them.
4. **Verification status.** Mark facts confirmed by a person versus inferred by a model, and let the confirmed one win in conflicts.
5. **Supersede, don't delete.** Old decisions get marked deprecated and linked to what replaced them, so the history of why stays.
6. **Sources.** Each fact links to where it came from: the session, issue, PR or commit.
7. **Traps are the most valuable entries.** Make them a first-class type and show them prominently to agents working nearby.
8. **A concrete example with each rule.** The author found rules with a real incident attached are followed much more reliably.

## Lessons for hooks and enforcement

1. **Repeated corrections become enforcement.** If a person corrects an agent twice for the same thing, Wheelhouse could suggest turning it into a rule.
2. **Rules live in the tools, not the prose.** Wheelhouse's MCP tools should enforce workflow rules (who can move statuses, what "done" requires) so agents can't skip them.
3. **Validate every memory write.** On save: check the format, fix links, update the index, and reject broken entries.
4. **A session-start check.** When an agent starts, show stale facts and relevant traps for the area it's working in.
5. **No dead ends.** If an agent is unsure, the only allowed move is to ask on the issue and mark it blocked.
6. **Make checking cheap.** Give agents status tools that answer "what's true right now" in one call, so they check instead of guessing.

## Should memory be a separate thing, designed from scratch?

Make it a distinct concept in the product, but not a separate system, and don't start from zero.

- **Distinct concept:** memory (decisions, rules, traps, facts) is the main differentiator and deserves its own model, view and API, not a folder of generic docs.
- **Not a separate system:** it should sit in the same schema as issues, projects and docs, and link to them. A decision links to the conversation it came from and the issues it created. A trap links to the code area. That linking is the value. A separate memory store would lose it and duplicate the docs module.
- **Not from scratch:** build on the docs module, the map and the issue model. Add memory as typed entries with the fields above (type, status, freshness, verified by, sources, supersedes), and reuse the docs module where the content is long-form.
- **Portable:** export to markdown files in the repo, so users keep ownership and agents without Wheelhouse can still read it. That also lowers the barrier for people who already keep md memory files.

Open question: how much of this the current docs module already covers. Next step is to check the schema and sketch how memory entries fit into it, to see whether this is an extension or a new set of tables.
