# Chat with the codebase on your own device (first slice)

Status: **being built** on `wh/agents-frontend`, 2026-10-25. Daemon side lives in the `wheelhouse-cli` repo (`daemon/`). This is the
"phase 2" the daemon's `DESIGN.md` mentions, thinned to one end-to-end path so the idea can be tested whole.

## What the slice does

A person opens **Chat** in Wheelhouse, picks a repository, one of their online devices and a model, and asks a question. The message goes to
their machine as a signed device message. The daemon runs the person's own `claude` CLI, read-only, over a checkout of that repository and
streams the answer back. The thread can be continued (the Claude session is resumed) and a running answer can be stopped.

Out of scope for the slice: shell access, editing, sharing threads, several repositories
in one thread, a model picker per message, attachments, permission prompts.

## Rules

- Read-only: claude runs with `Read,Grep,Glob` and read-only git (`log`, `diff`, `show`, `blame`, `grep`, `status`, `ls-files`, `ls-tree`,
  `rev-parse`, `merge-base`, `branch -r|-a`), plus `git checkout --detach` to move its own checkout to another branch. No other shell, no
  edits. MCP is only Wheelhouse, read-only, with the message's own key (`--strict-mcp-config` with that one server; none without a key). Plain `git branch` is not allowed: `-D` would delete a run's branch in the shared clone.
- Unmodified `claude` binary, the user's own sign-in, no Agent SDK (same ground rules as jobs).
- Chats are the person's own: a thread belongs to its owner, only they see it, only on a device they own.
- Chats are separate from jobs: their own small pool (2 at once), not counted in the job pool. A usage-limit pause (`pausedUntil`) applies to both.

## Data (server)

`chat_threads`: id, team_id, workspace_id (`teamScope`), owner_id, device_id (FK `(device_id, workspace_id)` to devices), repository_id
(nullable, set null on delete), model, title (first message, cut to 80), session_id (the Claude session, null until the first reply reports it),
created_at, updated_at.

`chat_messages`: id, thread_id (cascade), team_id, workspace_id (`teamScope`), seq (int, order in the thread, unique per thread), role
(`user` | `assistant`), content (text), state (`done` | `pending` | `streaming` | `failed` | `canceled`; user messages are always `done`),
error (text), activity (jsonb array of `{ name, summary }`, the latest 30 tool calls), last_event_seq (int, the highest daemon event seq
applied, -1 at the start), cost_usd (numeric, null), created_at, updated_at.

Sending a message inserts the user message and an empty assistant message (`pending`) in one transaction and writes a `chat.message` to the
device. At most one assistant message per thread is `pending` or `streaming` (409 otherwise).

## Device messages (server → daemon, signed like job offers)

Add `chat.message` and `chat.cancel` to `DEVICE_MESSAGE_TYPES` (and to the `device_messages_type_check` constraint, in a migration).

```
chat.message  { messageId, threadId, model, sessionId | null, prompt,
                repository: { id, name, fullName, cloneUrl, defaultBranch }, expiresAt, mcp: { token } }
chat.cancel   { messageId }
```

`messageId` is the **assistant** message's id (the one being filled). `sessionId` is the thread's session to resume, null on the first message.
`expiresAt` is 60 s out: a daemon that gets it later drops it.

## Wheelhouse data

Each `chat.message` carries `mcp: { token, write }`, a key minted for that answer, reaching only the thread's team, named
`<person> (chat)` so its writes (issues, comments, the activity feed) read as the person via chat. Its scopes are the instance's
`CHAT_SCOPES` (default `read,board:write,map:write,docs:write`; `read` is always held, `planning:write` never is). `CHAT_SCOPES=read`
makes every chat read-only; `write` is true when the key holds any scope besides `read`. The daemon reaches `<server URL>/mcp` with it as a bearer token. The key is deleted when the answer ends (finish,
offline cancel, sweep failure) and expires 10 minutes after it was minted at the latest (`api_keys.expires_at`; `actorForKey` rejects it,
the sweep deletes it). `api_keys.chat_message_id` marks it: such keys are left out of the keys page, the Agents page and the dashboard
counts. Only its hash is stored, like any key.

## Daemon → server (device token, same `DeviceGuard`)

```
POST /api/daemon/chat/:messageId/events   { events: [{ seq, at, type, data }] }   → { stored }
POST /api/daemon/chat/:messageId/finish   { state: "done"|"failed"|"canceled", sessionId?, text?, costUsd?, error? } → { ok: true }
```

Event types: `delta` `{ text }` (appended to `content`), `tool` `{ name, summary }` (appended to `activity`), `phase` `{ phase, detail? }` (ignored by
storage, shown live is not needed). `seq` is numbered by the daemon from 0 per message; the server applies an event only if `seq >
last_event_seq`, so a resent batch is harmless. The first accepted event moves `pending` → `streaming`. Batches go every ~250 ms.

`finish` sets the final state. If `text` is given and `content` is empty (the CLI gave no partial deltas), `content = text`. `sessionId` is stored on
the thread. A message already final answers 409 (the daemon stops retrying). `failed`/`canceled` keep whatever content streamed so far.

Housekeeping (the existing sweep): a `pending` message with no event 60 s after creation, or a `streaming` one with none for 3 minutes, becomes
`failed` ("Your device did not answer" / "Your device went quiet").

## Person ↔ server (`/api/app`, session auth, CSRF as elsewhere)

```
GET    /api/app/chats                       → { chats: ChatThreadView[] }          the person's threads, newest first
POST   /api/app/chats                       { teamKey, repositoryId, deviceId, model, message } → { chat: ChatThreadView, messages: ChatMessageView[] }
GET    /api/app/chats/options?teamKey=      → { devices: [{id,name,status,models}], repositories: [{id,name,fullName,defaultBranch}] }
GET    /api/app/chats/:id                   → { chat: ChatThreadView, messages: ChatMessageView[] }
POST   /api/app/chats/:id/messages          { message } → { messages: ChatMessageView[] }   (the new user + assistant pair); 409 while one is running
POST   /api/app/chats/:id/cancel            → { chat: ChatThreadView }   (sends chat.cancel; the assistant message ends canceled when the daemon reports, or at once if the device is gone)
DELETE /api/app/chats/:id                   → 204   (cancels a running answer first)
```

Views (shared type names in `@wheelhouse/api-client`):

```ts
type ChatThreadView = { id; title; teamKey; repositoryId: string|null; repositoryName: string|null; deviceId; deviceName; deviceStatus; model;
                        running: boolean; createdAt; updatedAt };
type ChatMessageView = { id; seq; role: "user"|"assistant"; content; state: "done"|"pending"|"streaming"|"failed"|"canceled"; error: string|null;
                         activity: { name: string; summary: string }[]; costUsd: number|null; createdAt };
```

Validation mirrors `runOnDevice`: the device must be the person's own and online, the model one it offers, the repository one of the team's
runnable repositories, the message 1–8000 chars.

Live updates: each change to a thread publishes `{ type: "chat.updated", entity: "chat", entityId: threadId, recipientUserId: owner }` on the
bus (throttled to once per 300 ms for deltas, immediate for state changes). The web page refetches the thread on that signal, and polls every
1.5 s while a message is `pending` or `streaming` as a fallback.

## Daemon behaviour

- `chat.message` is verified like every message (signature, device id, expiry). If the chat pool (2) is full, or the usage-limit pause is on, it
  reports `finish { state: "failed", error }`.
- Workspace: `ensureClone(repository)` (fetches), then a **detached** worktree at `~/.wheelhouse/daemon/chats/<repositoryId>/<threadId>`,
  made on `origin/<defaultBranch>` for a new thread. After that the daemon leaves it where it is: the chat switches branches itself when
  asked ("look at development" → `git checkout --detach origin/development`) and finds it there on the next message. Each message tells the
  agent the commit and the `origin/…` branches at it. Pruned after 24 h unused. The branch is never one jobs use.
- Run: `claude -p <prompt> --model <m> [--resume <sessionId>] --output-format stream-json --verbose --include-partial-messages --restricted
  --strict-mcp-config --tools Read,Grep,Glob,Bash --allowedTools <the list above> --permission-mode manual --permission-prompts none --settings '{"disableAllHooks":true}'
  --append-system-prompt <CHAT_RULES>`, cwd = the thread's worktree. Flag names must be checked against `claude --help` of the installed CLI.
- The prompt is the person's message as typed; the rules say: read-only assistant for repository X, now at commit Y (tip of origin/Z), answer
  from the code, cite file paths and branch, use read-only git for history and other branches, switch with `checkout --detach`, one command
  per call, no other commands or edits, and read Wheelhouse (issues, cycles, projects, the map, docs) with the wheelhouse tools, citing issue refs.
- stream-json → events: `stream_event` with a `text_delta` → `delta`; `tool_use` blocks → `tool`; `result` → `finish` (with `session_id`, cost, text).
- `chat.cancel` aborts that run (SIGTERM to the process group, as jobs do); the daemon then reports `canceled`.
- A rate-limit result sets `pausedUntil` like a job does.
