# The web app's API (`/api/app/*`)

The React app talks to the NestJS API through this API. It replaces the Next app's 59 server actions (`src/app/actions.ts`, now archived at tag `archive/next-app`) and
the data its pages read on the server. It is **new surface, used only by the web app**: it is not part of the frozen external
contract (`/mcp`, `/api/v1`, webhooks, streams), and the Next app does not have it. The typed client is
`@wheelhouse/api-client`; the CSRF rules are in `apps/api/src/web/csrf.ts`.

Built so far: `GET /api/app/auth/options`, `POST /api/app/auth/login`, `POST /api/app/auth/signup`,
`POST /api/app/auth/logout`, `GET /api/app/me`, `GET /api/app/teams` (WH-93), and everything under "Built by WH-95" below. The
other page-port tickets add the rest (inventory below).

## Conventions

**Paths.** Resource style. Things that belong to a team live under `/api/app/teams/:key/...`; a ticket is addressed by
its ref (`/api/app/tickets/WH-12`), which already contains its team. Collections are `GET` and return an object with the
plural name (`{ "teams": [...] }`), never a bare array, so a field can be added later. Reads are `GET` and never change
anything.

**Methods and statuses.** `POST` creates (201) or performs an action (200), `PATCH` changes part of a resource, `PUT` replaces
or upserts at a known address, `DELETE` removes. A mutation returns the resource as it is now; a delete or an action with
nothing to return answers `{ "ok": true }`. There is no 204: every success has a JSON body.

**Requests.** A JSON object. A missing, unparseable or non-object body is a 400 `invalid`. The workspace is **never** taken from
the request: not from a path, a query or a header. It is the signed-in person's workspace, read from their session.

**Errors.** One shape everywhere: `{ "error": { "code": "...", "message": "...", "details": ... } }`.

| Status | `code` | When |
|---|---|---|
| 400 | `invalid` | bad input; `details.fields` is `{ fieldName: message }` when particular inputs are at fault |
| 401 | `unauthorized` | not signed in (a JSON 401, never a redirect), or a wrong email or password |
| 403 | `csrf_failed` | the CSRF check failed (see below) |
| 403 | `forbidden` | signed in but not allowed (for example, owners only) |
| 403 | `team_suspended` | the workspace is suspended |
| 403 | `signup_closed` | sign-up is not open on this server |
| 404 | `not_found` | not there, **or belongs to another workspace** (the two look the same) |
| 409 | `conflict` | the thing changed since you read it, or already exists; for an optimistic-lock conflict `details.current` holds what the server has now |
| 429 | `rate_limited` | too many tries; `Retry-After` says how many seconds |
| 500 | `internal` | a bug; nothing more is said |

**Optimistic locking.** Anything with a `version` (tickets, docs, nodes) takes it in the body of the change. If it is stale the
answer is `409 conflict` with the current copy in `details.current`, and nothing is overwritten.

**Sessions.** The `wh_session` cookie is the same cookie the Next app sets (httpOnly, SameSite=Lax, Secure in production, 30
days), so a session started here works on `/api/v1` and the other way round. Every request resolves the person and their workspace
from it. Sign-in and sign-up answer with the person, their workspace and role, and the CSRF token.

## CSRF

Next gave server actions same-origin protection implicitly. JSON endpoints do not, so this API checks every state-changing
request (`POST`, `PUT`, `PATCH`, `DELETE`) itself. Reads are never checked.

1. **Origin.** If the request says where it came from (`Origin`, else `Referer`) that must be this site (the `Host`, or an
   origin in `APP_URL` / `APP_ORIGINS`). `Origin: null` and anything unreadable are refused. A request with neither header (curl, a
   native client) goes on to check 2. A browser always sends `Origin` on a cross-site `POST`, so a forged one stops here.
2. **Token.** `X-CSRF-Token` must equal the token for the session: an HMAC of the session cookie's secret value, returned in
   the body of `GET /api/app/me`, sign-in and sign-up. Before sign-in (sign-in and sign-up themselves) it must be the literal
   `anonymous`. A page on another site can neither send a custom header (that needs a CORS preflight, which this API never
   approves; there are no CORS headers at all) nor read the token from a response.
3. `SameSite=Lax` on the cookie is the first line of defence and stays.

Either failing is `403 csrf_failed` (`Cross-site request refused` or `Missing or invalid CSRF token`). The typed client sends the
token for you and, if the server says it went stale (signed in or out in another tab), fetches a new one and retries once.

## Adding an endpoint

1. The logic goes in `@wheelhouse/core`, as a function that takes the actor. A controller reads the request and writes the
   response and **never touches the database**; the isolation audit fails if a file under `apps/api/src` calls `getDb()`.
2. `@Controller("api/app/...")` and `@AppEndpoints()` (CSRF and the error envelope); `@UseGuards(SessionGuard)` on anything for
   a signed-in person. Take the actor from `req.human`.
3. Add the route to `API_ROUTE_AUDIT` in `src/lib/isolation.test.ts`, saying how it is scoped to the workspace. A route without an
   entry fails the test.
4. Contract tests in `tests/contract/*.app.contract.test.ts` (`pnpm test:contract --suite app --server-cmd "pnpm --filter
   @wheelhouse/api start"`): the happy path, signed out, another workspace's data, a stale `version`, and a forged request.
5. A method on `@wheelhouse/api-client`.

Pages also read data on the server, not only through actions (for example the dashboard, workspace, agents, admin, repositories and
map pages). Each page-port ticket needs `GET` endpoints for those reads too; they are not in the inventory because they are not
actions.

## Inventory of the 59 server actions

Every exported action in `src/app/actions.ts` has exactly one row (a test keeps it that way). "Owner" is the ticket that builds
the endpoint: WH-95 dashboard, workspace, agents, admin, new team, auth and invite pages; WH-96 board and ticket dialog; WH-97
map, decisions, glossary and activity; WH-98 docs, repositories and onboarding. "unneeded" means there is nothing to port, with
the reason.

| Server action | Endpoint | Owner | Notes |
|---|---|---|---|
| `signup` | `POST /api/app/auth/signup` | WH-93 | built; 201, signs in |
| `login` | `POST /api/app/auth/login` | WH-93 | built; 200, signs in |
| `logout` | `POST /api/app/auth/logout` | WH-93 | built; 200 `{ ok: true }` |
| `createInviteAction` | `POST /api/app/invites` | WH-95 | also used by the onboarding wizard (WH-98); owner/admin rules and the 20-per-hour limit stay in core |
| `revokeInviteAction` | `DELETE /api/app/invites/:id` | WH-95 |  |
| `lookupInviteAction` | `POST /api/app/invites/peek` | WH-95 | POST so the token never sits in a URL or a log; public (no session), rate limited per address |
| `acceptInviteAction` | `POST /api/app/invites/accept` | WH-95 | public; creates the account and signs in like login; the two passwords must match |
| `suspendWorkspaceAction` | `POST /api/app/admin/workspaces/:id/suspend` | WH-95 | instance admins only |
| `restoreWorkspaceAction` | `POST /api/app/admin/workspaces/:id/restore` | WH-95 | instance admins only |
| `updateMember` | `PATCH /api/app/workspace/members/:userId` | WH-95 | owners only; role and tags |
| `removeMember` | `DELETE /api/app/workspace/members/:userId` | WH-95 | owners only |
| `changePassword` | `POST /api/app/me/password` | WH-95 | needs the current password |
| `createApiKey` | `POST /api/app/keys` | WH-95 | the secret is returned once, in this response only |
| `revokeApiKey` | `DELETE /api/app/keys/:id` | WH-95 |  |
| `setKeyDocsWriteAction` | `PATCH /api/app/keys/:id` | WH-95 | `{ docsWrite: boolean }` |
| `createTeamAction` | `POST /api/app/teams` | WH-95 | extends the GET already built; 201 |
| `createConceptFromDescriptionAction` | `POST /api/app/teams/:key/onboarding/concept` | WH-98 | onboarding wizard |
| `latestSeq` | none | unneeded | only fed the polling refresh; replaced by the SSE stream (WH-94) |
| `moveTicketAction` | `POST /api/app/tickets/:ref/move` | WH-96 | `{ column, index? , version? }`; the column by role or name, as in `move_ticket` |
| `createTicketAction` | `POST /api/app/teams/:key/tickets` | WH-96 | 201; also serves createTicketFromActionItemAction |
| `updateTicketAction` | `PATCH /api/app/tickets/:ref` | WH-96 | `version` in the body; a stale one is a 409 `conflict` with `details.current` |
| `deleteTicketAction` | `DELETE /api/app/tickets/:ref` | WH-96 |  |
| `getTicketAction` | `GET /api/app/tickets/:ref` | WH-96 | ticket, comments, linked nodes, history, pull requests |
| `commentAction` | `POST /api/app/tickets/:ref/comments` | WH-96 | 201 |
| `linkNodeAction` | `PUT /api/app/tickets/:ref/nodes/:nodeId` | WH-96 | DELETE on the same path unlinks (the `unlink` flag) |
| `getGraphAction` | `GET /api/app/teams/:key/graph` | WH-97 | nodes, edges, flows, decisions, terms |
| `upsertNodeAction` | `PUT /api/app/teams/:key/nodes` | WH-97 | create or update by id or name; `version` for the optimistic lock |
| `deleteNodeAction` | `DELETE /api/app/teams/:key/nodes/:id` | WH-97 |  |
| `saveLayoutAction` | `PUT /api/app/teams/:key/layout` | WH-97 | positions of many nodes in one call |
| `connectNodesAction` | `POST /api/app/teams/:key/edges` | WH-97 | `{ from, to, label?, kind }` |
| `deleteEdgeAction` | `DELETE /api/app/teams/:key/edges/:id` | WH-97 |  |
| `markFreshAction` | `POST /api/app/teams/:key/nodes/:id/fresh` | WH-97 |  |
| `upsertFlowAction` | `PUT /api/app/teams/:key/flows` | WH-97 | create or update |
| `deleteFlowAction` | `DELETE /api/app/teams/:key/flows/:id` | WH-97 |  |
| `upsertDecisionAction` | `PUT /api/app/teams/:key/decisions` | WH-97 | also used by the docs page to make an ADR from a decision record (WH-98) |
| `upsertTermAction` | `PUT /api/app/teams/:key/terms/:term` | WH-97 |  |
| `deleteTermAction` | `DELETE /api/app/teams/:key/terms/:term` | WH-97 |  |
| `askAction` | `POST /api/app/teams/:key/ask` | WH-97 | calls the Claude API from the server; the key never reaches the browser |
| `resolveDraftAction` | `POST /api/app/teams/:key/drafts/:id/resolve` | WH-97 | `{ action: "publish" | "discard" }` |
| `listDocsAction` | `GET /api/app/teams/:key/docs` | WH-98 | the doc tree |
| `getDocAction` | `GET /api/app/teams/:key/docs/:ref` | WH-98 |  |
| `createDocAction` | `POST /api/app/teams/:key/docs` | WH-98 | `{ title, body?, parent?, template? }`; 201 |
| `listDocTemplatesAction` | none | unneeded | not called by any page today; the five templates are static data the web app can ship |
| `createTicketFromActionItemAction` | `POST /api/app/teams/:key/tickets` | WH-98 | the same endpoint as createTicketAction (WH-96); the docs page then ticks the item with an ordinary doc update |
| `updateDocAction` | `PATCH /api/app/teams/:key/docs/:ref` | WH-98 | `version` in the body; 409 `conflict` with `details.current` |
| `markDocFreshAction` | `POST /api/app/teams/:key/docs/:ref/fresh` | WH-98 |  |
| `suggestDocAnchorsAction` | `GET /api/app/teams/:key/docs/:ref/anchor-suggestions` | WH-98 | a read |
| `moveDocAction` | `POST /api/app/teams/:key/docs/:ref/move` | WH-98 | `{ parent?, index?, version? }` |
| `deleteDocAction` | `DELETE /api/app/teams/:key/docs/:ref` | WH-98 |  |
| `linkDocNodeAction` | `PUT /api/app/teams/:key/docs/:ref/nodes/:nodeId` | WH-98 | DELETE on the same path unlinks |
| `resolveDocDraftAction` | none | unneeded | not called by any page today; if the docs UI needs it later, add `POST /api/app/teams/:key/doc-drafts/:id/resolve` |
| `listRepositoriesAction` | `GET /api/app/teams/:key/repositories` | WH-98 | also read by the docs anchor picker |
| `createRepositoryAction` | `POST /api/app/teams/:key/repositories` | WH-98 | any teammate (as before); 201 |
| `connectGithubRepositoryAction` | `POST /api/app/teams/:key/repositories/github` | WH-98 | owners only; the installation must be the workspace's own (ADR-12); name and branch are read from GitHub |
| `updateRepositoryAction` | `PATCH /api/app/teams/:key/repositories/:id` | WH-98 | any teammate (as before) |
| `retireRepositoryAction` | `POST /api/app/teams/:key/repositories/:id/retire` | WH-98 | any teammate (as before) |
| `browseRepoTreeAction` | `GET /api/app/teams/:key/repositories/:id/tree` | WH-98 | for the anchor picker |
| `markAllSeenAction` | `POST /api/app/agents/mark-all-seen` | WH-95 | `{ keyId?, teamKey? }`; also used by the bots menu on the board (WH-96) |
| `removeSessionAction` | `DELETE /api/app/teams/:key/sessions/:sessionId` | WH-95 | built with the dashboard, whose agents widget uses it; the board's bots menu (WH-96) calls the same endpoint |

## Built by WH-95

The reads the pages make (not actions, so not in the inventory), and the endpoints from the inventory above that belong to this
ticket. Anything not marked public needs a session.

| Endpoint | What it is |
|---|---|
| `GET /api/app/workspace` | the workspace page: members with roles and tags, seats, and (owners only) the pending join invites |
| `GET /api/app/agents` | the Agents page: the workspace's keys (name, prefix, last used, `canWriteDocs`; never a key value) and the printed setup commands |
| `GET /api/app/invites?kind=join_workspace\|new_workspace` | pending invites. `new_workspace` is for instance admins; anyone else gets a 404 |
| `GET /api/app/admin/workspaces`, `GET /api/app/admin/workspaces/:id` | instance admins only; anyone else gets a 404. Names, emails and counts, never what a workspace wrote |
| `GET /api/app/dashboard/:widget` | one dashboard widget's data: `kpis`, `progress`, `throughput`, `activity-split`, `agents`, `attention`, `recent`, `sync`. An unknown widget is a 404 |
| `POST /api/app/invites/peek`, `POST /api/app/invites/accept` | **public** (no session; the CSRF token is `anonymous`), rate limited per address (30 tries per 15 minutes) |

Rules worth knowing:

- **Secrets are returned once.** `POST /api/app/keys` answers `{ key, secret }`; `POST /api/app/invites` answers `{ ..., link }` with the
  token in the link's `#fragment`. No later response contains either, and the client never needs to ask.
- **Limits live in core**, with the rules: 10 keys an hour and 20 invites an hour per person, 30 invite lookups per 15 minutes per address.
  A limit answers `429 rate_limited` with `Retry-After`.
- **Not found beats forbidden across workspaces.** Another workspace's member, key or invite is a 404 on every endpoint; only the same workspace's
  non-owner gets a 403.
- **Every bad invite link reads the same** (`400 invalid`, "This invite link is invalid or has expired."), so a link cannot be probed.
- The dashboard's widgets are separate requests so each one paints as soon as its own data arrives. They do not share a snapshot the
  way the Next app's single render did; if that matters under load, memoise per request in `@wheelhouse/core/lib/metrics` (`setRequestMemo`).

## Built by WH-96

The board and the ticket dialog. Everything needs a session. A ticket is addressed by its ref (`WH-12`, case-insensitive in the key), which already names its team, and a ticket or team of another workspace is a 404.

| Endpoint | What it is |
|---|---|
| `GET /api/app/teams/:key/board` | the team page in one read: `team`, `columns` (id, name, role, position), `tickets` (with `nodeIds` and `commentCount`), `nodes` (just id, name, kind, parentId, layer), `members` (id, name) and the setup `checklist` |
| `GET /api/app/teams/:key/queue` | the Bots menu: `{ bots }`, each agent key with its queue depth and live sessions in this team |
| `PATCH /api/app/tickets/:ref` | see "The version check" below |
| `POST /api/app/tickets/:ref/move` | `{ column, index?, version? }`: the column by id, name or role; `index` is the place in the column (the end when absent) |

A ticket in every answer has the same fields (`id`, `ref`, `number`, `title`, `body`, `columnId`, `priority`, `assigneeId`, `agentClaimable`, `claimedByKeyId`, `labels`, `position`, `version`, `createdByKind`, `createdAt`, `updatedAt`) and no internal ids. Create and move also say the column's `name`.

**Claiming.** Only agents claim a ticket (over MCP or `/api/v1`). A person decides whether agents may pick a ticket up (`agentClaimable`) and sees whether one has (`claimedByKeyId`); there is no web endpoint to claim.

**Input is checked like the MCP tools check it.** A wrong type is a 400 whose `details.fields` names the field: text for `title`/`body`/`column`, one of `low|medium|high|urgent` for `priority`, a list of text for `labels`, true or false for `agentClaimable`, a whole number for `version` and `index`. Unknown fields are ignored. An assignee must belong to the caller's workspace.

### The version check

The first real use of the optimistic-lock pattern described under "Optimistic locking" above.

- `PATCH` and `move` take `version`: the version you last read. If anyone (a person or an agent) changed the ticket since, the answer is `409 conflict`, nothing is changed, and `details.current` is the ticket as it is now, in the same trimmed shape (`ApiError.current` in the client).
- Two edits made from the same version: exactly one is applied and the other is a 409 (tested with two requests at once).
- Without `version` the change is applied over whatever is there, as the agents' own tools do. The web app always sends it for edits and not for moves made by dragging, because a drag is about position, not about what the ticket says.
- A change that alters nothing does not bump the version.

### Live updates

A change made by an agent over MCP or `/api/v1`, or by anyone through these endpoints, is one write path: it publishes an event on the team's stream (`/api/teams/:key/stream`) after it commits. A test holds a stream open, moves a ticket as an agent, and requires the `change` event within a second.

## Built by WH-97

The map, decisions, glossary and activity pages. Everything needs a session. A team, node, edge, flow, decision, term or draft of another workspace is a 404.

| Endpoint | What it is |
|---|---|
| `GET /api/app/teams/:key/graph` | the whole map in one read: `nodes`, `edges`, `ticketLinks`, `flows`, `decisions`, `terms`, `flux` (nodes whose code is being changed right now, with the map updates waiting for it) and `askEnabled`. The decisions and glossary pages read the same endpoint |
| `PUT /api/app/teams/:key/nodes` | create (no `id`) or change (`id`) a node; `{ name, layer, kind, status, parent, summary, purpose, responsibilities, interfaces, gotchas, details, anchors, columns, indexes, version }` |
| `PUT /api/app/teams/:key/layout` | `{ positions: [{ id, x, y, width?, height? }], placed? }`: a drag, a resize or a Tidy. `placed: false` is a whole-lens Tidy |
| `POST /api/app/teams/:key/edges` | `{ from, to, label?, kind? }`; `depends` (default) or `implements`. Answers 200 with the edge, new or existing. References between tables are made with a column's `references` |
| `PUT /api/app/teams/:key/flows` | `{ id?, name, description?, steps?: [{ node, title, detail? }], version? }`; steps are replaced wholesale |
| `PUT /api/app/teams/:key/decisions` | without `number` a new ADR; with it, that ADR is changed |
| `PUT/DELETE /api/app/teams/:key/terms/:term` | the term is named in the path (URL-encode it); `PUT` takes `{ definition, node? }`; `DELETE` takes the term's name or id |
| `POST /api/app/teams/:key/nodes/:id/fresh` | "still accurate": clears the stale flag without changing what the node says |
| `POST /api/app/teams/:key/drafts/:id/resolve` | `{ action: "publish" \| "discard" }` |
| `POST /api/app/teams/:key/ask` | `{ question, focus? }` → `{ answer, truncated }` |
| `GET /api/app/teams/:key/activity?who=agent\|human` | the last 200 events, newest first; `data` is only `ref`, `number` and `body` (cut at 500 characters) |

**Locks on nodes, flows and decisions.** These carry a `version` but nothing checked it before: not the old app, and not the agents' MCP tools (only tickets and docs had a lock). The web endpoints take `version` and use the same pattern as tickets: a change made since is a `409 conflict`, nothing is overwritten, and `details.current` is the entity as it is now (`ApiError.current`). The check is an optional `expectedVersion` on the service functions; the MCP tools never pass it, so agents behave exactly as before. Two edits from the same version give exactly one 200 and one 409.

**Ask the map spends money and calls out**, so: the team is resolved first (another workspace's is a 404 before anything is counted or called), then at most 20 questions per person per 10 minutes (`429` with `Retry-After`), then the server calls Claude with its own key. The key is read from the server's environment and is in no response, header or cookie (the contract suite checks that, including when Claude fails). Claude's own errors become plain reasons ("Claude is rate limited, try again in a moment", "ANTHROPIC_API_KEY is invalid", "Claude API error (500)"), never the upstream body. The contract suite runs Ask against a fake Claude server (`tests/contract/lib/fake-github.ts`) that answers from what it was sent.

**In flux and drafts.** When an agent's session is changing a node's files and the agent edits that node, the edit is stored as a draft and published when the code lands. `flux` in the graph lists those sessions and drafts per node; `resolve` publishes or discards one by hand.

**Renaming a term** is a delete of the old name and a define of the new one, as before (terms are keyed by name), so it is two calls.

## Built by WH-98

The docs, repositories and onboarding pages. Everything needs a session. A team, doc, map node or repository of another workspace is a 404.

| Endpoint | What it is |
|---|---|
| `GET /api/app/teams/:key/docs` | the tree (`docs`: id, parent, slug, title, version, position, updatedAt, stale) and what the page's panels offer: `nodes` to link, `decisions` to link, `members` (who wrote what) |
| `GET /api/app/teams/:key/docs/:ref` | one doc (a doc's id, or its slug) with the map nodes it is linked to. Only what the page shows: the internal freshness columns are not sent |
| `POST /api/app/teams/:key/docs` | `{ title, body?, parent?, template? }`; 201. A `template` (`spec`, `decision-record`, `runbook`, `meeting-notes`, `onboarding`) fills the body when none is given |
| `PATCH /api/app/teams/:key/docs/:ref` | `{ title?, body?, anchors?, version? }`; with `version`, a doc changed since is a `409 conflict` and `details.current` is the doc now. Editing text or anchors clears the stale flag |
| `POST /api/app/teams/:key/docs/:ref/fresh` | "still accurate" |
| `GET /api/app/teams/:key/docs/:ref/anchor-suggestions` | `{ anchors }`: path-like words in the text and the anchors of the linked nodes |
| `POST /api/app/teams/:key/docs/:ref/move` | `{ parent?, index?, version? }`; `parent: null` is the top level; cycles are refused |
| `DELETE /api/app/teams/:key/docs/:ref` | the doc and the docs nested under it |
| `PUT/DELETE /api/app/teams/:key/docs/:ref/nodes/:nodeId` | link / unlink a map node |
| `GET /api/app/teams/:key/repositories` | `{ repositories }`: a view without installation or GitHub ids; `browsable` says a GitHub repository's tree can be fetched |
| `POST /api/app/teams/:key/repositories` | `{ displayName, role, provider?, defaultBranch?, pathLimit?, lifecycle? }`; 201 |
| `PATCH /api/app/teams/:key/repositories/:id` | any of the same fields (`pathLimit: null` clears it) |
| `POST /api/app/teams/:key/repositories/:id/retire` | |
| `GET /api/app/teams/:key/repositories/github` | the Connect GitHub card: `configured`, `missing` (settings to set; owners only), `isOwner`, and for owners each installation of the workspace with the repositories this team could still connect. GitHub is asked on every read |
| `POST /api/app/teams/:key/repositories/github` | `{ installationId, repoId, role?, pathLimit? }`; 201. Owners only; the installation must be the workspace's own (ADR-12); the name and default branch are read from GitHub, not the request |
| `GET /api/app/teams/:key/repositories/:id/tree` | `{ files, truncated }` for the doc anchor picker; only for a GitHub repository of the person's own team |
| `GET /api/app/teams/:key/onboarding` | the wizard: the team, `hasRepos`, and the commands to paste (with this team's key; never an API key) |
| `POST /api/app/teams/:key/onboarding/concept` | `{ description }`: the "no code yet" path; becomes the map's first concept. An empty one is a 400 on `description` |

Creating, editing and retiring repositories is open to any teammate, as it was in the Next app (the inventory above first said "owners only"; the code never checked it). Connecting GitHub is owners only.

**The Connect GitHub redirects are unchanged.** `/api/github/install` and `/api/github/callback` are the same Nest routes as before and send the person back to `/t/KEY/repos?github=connected` (or `github_error=...`), which the React page turns into the same notes. The GitHub App's settings and callback URL need no change.

**Connecting a repository** used to be a form that redirected to `?github=repo_connected`; it is now a fetch, and the page shows "Repository connected." (or the server's reason) on that installation and reads the list again. The words are the same.

**An action item becomes a ticket** through `POST /api/app/teams/:key/tickets` (WH-96), then the page ticks the box with an ordinary `PATCH` of the doc against the version it read. "Create ADR from this doc" is `PUT /api/app/teams/:key/decisions` (WH-97).

## Built by WH-105: who can open a team (ADR-23)

A team is reachable only by its members. Every route below is for a signed-in person; an agent key cannot call them. A team you are not in, and a team of another workspace, are the same plain `404`; a member whose role is too low gets `403`.

| Endpoint | Notes |
|---|---|
| `GET /api/app/teams` | now only the teams the person is a member of (an agent key still sees its whole workspace) |
| `POST /api/app/teams` | workspace viewers and guests get `403`; the creator becomes the team's admin |
| `GET /api/app/teams/:key/members` | `{ team, myRole, members: [{ userId, name, email, role, workspaceRole, addedAt }] }`. Any member |
| `GET /api/app/teams/:key/members/addable` | `{ people }`: workspace members not yet in the team. Team admins |
| `POST /api/app/teams/:key/members` | `{ userId, role }` with role `admin`, `editor` or `viewer`; 201. Team admins; the person must be in the workspace; already in is a `409` |
| `PATCH /api/app/teams/:key/members/:userId` | `{ role }`. Team admins; the last admin cannot be demoted (`409`) |
| `DELETE /api/app/teams/:key/members/:userId` | remove someone, or leave yourself. The last admin cannot go (`409`) |
| `POST /api/app/teams/:key/join` | a workspace owner or admin joins as the team's admin. Audited, and shown in the team's own activity |
| `GET /api/app/access/teams` | every team of the workspace by name with its admins and whether you are in it. Workspace owners and admins |
| `GET /api/app/access/audit?team=KEY&limit=` | the access audit log, newest first. Workspace owners and admins |

Workspace roles are now `owner`, `admin`, `member`, `viewer` and `guest`. Owners and admins invite, change roles and remove members (`/api/app/workspace/...`, `/api/app/invites`); only an owner can make, change or remove an owner. Removing a person who is the only admin of a team is a `409` that names the teams. `/api/v1` and `/mcp` are unchanged: an agent key keeps the access it had.

**More from WH-105.**

| Endpoint | Notes |
|---|---|
| `GET /api/app/teams` | each team now carries `role`, the caller's own role in it |
| `POST /api/app/invites` | join invites take `teams: [{ team: "KEY", role }]`; the caller must administer each one (`403` otherwise); at most 20. A pending invite lists them under `teams` |
| `POST /api/app/invites/peek-existing` | signed in: what an invite sent to your own address would add you to. Anyone else's invite, or a bad token, is the usual `400` |
| `POST /api/app/invites/accept-existing` | signed in: join that workspace with the account you have (you keep your other workspaces); this session then works in it. Already a member is a `409` and the invite stays unused |
| `GET /api/app/me/workspaces` | `{ workspaces: [{ id, name, role, active }] }`; a suspended workspace is left out |
| `POST /api/app/me/workspace` | `{ workspaceId }`: this session works in another of your workspaces. Not yours, suspended or malformed is a `404`. Only this session changes; every cached read in the browser belongs to the old workspace and is dropped |

A person who belongs to several workspaces works in one at a time, chosen per session (`sessions.active_workspace_id`; null means their first). Addresses do not carry the workspace (`/w/<slug>/...` is not built): two tabs of one session are in the same workspace. A workspace an instance admin suspended is never chosen; someone is locked out only when every workspace of theirs is suspended. Open event streams re-check access every 15 seconds: a team stream ends when its person is removed, and the dashboard stream follows joins and removals.

**Wording.** The product says "workspace" where the code says "workspace" (tables, ids, URLs such as `/workspace` and `/api/app/workspace` are unchanged). Messages shown to people were reworded; messages that are part of the frozen `/api/v1` and `/mcp` contract were not.

## Built by WH-107: a dashboard for each team

`GET /api/app/dashboard/:widget` now takes an optional `?team=KEY`. Without it the widgets read the whole workspace, limited to the teams the person is in (as before). With it they read that one team: the team is resolved through `requireTeam`, so another workspace's team, one the person is not in, a malformed value or a repeated `team` parameter is a `404`, and the numbers come from a snapshot limited to that team. An empty `?team=` means the workspace.

| Widget | For one team |
|---|---|
| `kpis`, `progress`, `throughput`, `activity-split`, `attention`, `recent`, `sync` | the same shapes, for that team only. `kpis` gained `agentsActive7d` (agents that changed something in the team in 7 days) |
| `agents` | only the agents that do something in that team (pending changes, actions in 7 days or a live session) |
| `focus` | **team only** (`404` without `?team=`): what has waited longest for review, what has sat longest in progress, agents gone quiet, decisions still proposed, member count and the caller's role. "How long" is time since the ticket last moved into its column |

The page is `/t/:key/overview` ("Overview", first in the team sidebar). It draws the same widget components as the home page, inside a scope that says which team (`lib/dashboard-scope`), so a widget added to `TEAM_WIDGETS` in `pages/dashboard/registry.tsx` appears on every team's Overview. It stays live through the team's own event stream (opened by the team layout) and a 30 s tick. The home page's team rows link to it.
