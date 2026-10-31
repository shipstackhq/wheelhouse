# Quick Chat: ask Wheelhouse from anywhere

Status: **draft**, 2026-10-29.

## Problem

Chat is a full page behind the sidebar, tied to a repository, a device and a model. Most questions are small ("what is this issue blocked on?", "where do I set up a key?") and don't deserve a page change or a setup. Quick Chat is a centered, always-reachable prompt that answers them in place.

## Goals

- Open from any page with one shortcut (e.g. `Cmd/Ctrl+J`), centered over the page, dismissed with Esc.
- Answer questions about **the page the user is on**, using that page's data.
- Answer **general questions about Wheelhouse** (how features work, where things live).
- Fast: the first words stream in within about a second. No device, repository or model pickers.

## Non-goals

- Code questions over a repository checkout. These stay in the full Chat page (device, worktree); Quick Chat can point there.
- Writing or editing anything. Quick Chat is read-only.

## Experience

1. Shortcut (or a small header trigger) opens a centered panel: one input, a context chip ("Issue WH-42"), the answer area.
2. The chip shows what the model will see. The user can remove it for a general question.
3. The answer streams in as Markdown; issue refs and `[[layer:Name]]` are linked (existing `linkifyRefs`).
4. Follow-ups stay in the panel until the page reloads.
5. With an empty input, a few suggested prompts per page type (on an issue: "Summarize this", "What's blocking this?").

## How it answers

Server-side, no device. Same shape as `AskService.askMap` (`apps/api/src/modules/map/ask.service.ts`): the server calls Claude with its own key, streams the answer, and rate-limits per person (shares `ASK_LIMIT`).

Prompt inputs:

1. **App guide** (static, cached system block): a short product description plus an index of pages to features, kept in the repo. Answers "how do I…" questions.
2. **Page context** (sent by the client per message): `{ route, teamKey, entity: { type, id } | null }`. The server loads the entity itself with the caller's permissions and renders it as compact text (issue with status, comments, links; cycle; project; doc; map node). The client never sends page content.
3. **Read tools** over existing services (get/list issues, cycles, projects, docs, map search), scoped to the caller's team. Lets a question go beyond the current page ("what else is in this cycle?").

The knowledge map is rendered into a cached block for architecture questions, as Ask does today.

## Page context contract

A page registers what it is showing with a small hook:

```ts
useQuickChatContext({ type: "issue", id, label: "WH-42 Fix login" });
```

- Only a **reference** (type, id, label) is sent. Pages don't serialize their own state.
- A route with no provider sends `{ route }` and is answered from the app guide.
- First providers: issue, cycle, project, doc, map node. Others as needed.

## API

```
POST /api/app/quick-chat   { teamKey, message, history: [{ role, content }], context: { route, entity? } }
→ streamed text (SSE), then { done, truncated }
```

- Session auth and CSRF as elsewhere. Message 1 to 2000 chars; history capped to the last 10 turns.
- Plain "disabled" message when `ANTHROPIC_API_KEY` is unset (`askEnabled`).
- No storage in v1: threads live in the client, so there is nothing to migrate.

## Web

- One `QuickChat` mounted in the app shell, a Radix Dialog like `AskDialog`, following Lucid.
- Current context lives in a small Zustand store written by the hook.
- The sidebar Chat link stays for the device chat; consider renaming it "Code chat" if the two confuse people.

## Safety and cost

- Read-only tools; entities load as the caller's actor, so no one sees what they couldn't open.
- Page text (issue comments, doc bodies) is untrusted: wrap it in tags and tell the model it is data, not instructions.
- Per-person rate limit shared with Ask; cap output length; mid-tier model and effort by default.

## Testing

- API: context resolution respects team access; rate limit; disabled state; history cap.
- Web: shortcut opens and closes; chip shows context and can be removed; answer streams and links refs.
- By hand: ask on an issue page, a cycle page, and a page with no provider.

## Open questions

- Replace the Ask-the-map dialog (recommended: one entry point; the map becomes one more context) or keep both?
- Rename the sidebar Chat page?
- Persist threads later so a quick answer can become a full chat?

## Rollout

1. Endpoint with app guide and issue context, with tests.
2. Panel, shortcut and hook; issue and cycle providers.
3. Read tools; remaining providers.
4. Fold in Ask-the-map; settle the sidebar label.
