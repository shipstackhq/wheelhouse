# The web app's API (`/api/app/*`)

The React app talks to the NestJS API through this API. It replaces the Next app's 59 server actions (`src/app/actions.ts`, now archived at tag `archive/next-app`) and
the data its pages read on the server. It is **new surface, used only by the web app**: it is not part of the frozen external
contract (`/mcp`, `/api/v1`, webhooks, streams), and the Next app does not have it. The typed client is
`@wheelhouse/api-client`; the CSRF rules are in `apps/api/src/web/csrf.ts`.

Built so far: `GET /api/app/auth/options`, `POST /api/app/auth/login`, `POST /api/app/auth/signup`,
`POST /api/app/auth/logout`, `GET /api/app/me`, `GET /api/app/projects` (WH-93), and everything under "Built by WH-95" below. The
other page-port tickets add the rest (inventory below).

## Conventions

**Paths.** Resource style. Things that belong to a project live under `/api/app/projects/:key/...`; a ticket is addressed by
its ref (`/api/app/tickets/WH-12`), which already contains its project. Collections are `GET` and return an object with the
plural name (`{ "projects": [...] }`), never a bare array, so a field can be added later. Reads are `GET` and never change
anything.

**Methods and statuses.** `POST` creates (201) or performs an action (200), `PATCH` changes part of a resource, `PUT` replaces
or upserts at a known address, `DELETE` removes. A mutation returns the resource as it is now; a delete or an action with
nothing to return answers `{ "ok": true }`. There is no 204: every success has a JSON body.

**Requests.** A JSON object. A missing, unparseable or non-object body is a 400 `invalid`. The team is **never** taken from
the request: not from a path, a query or a header. It is the signed-in person's team, read from their session.

**Errors.** One shape everywhere: `{ "error": { "code": "...", "message": "...", "details": ... } }`.

| Status | `code` | When |
|---|---|---|
| 400 | `invalid` | bad input; `details.fields` is `{ fieldName: message }` when particular inputs are at fault |
| 401 | `unauthorized` | not signed in (a JSON 401, never a redirect), or a wrong email or password |
| 403 | `csrf_failed` | the CSRF check failed (see below) |
| 403 | `forbidden` | signed in but not allowed (for example, owners only) |
| 403 | `team_suspended` | the team is suspended |
| 403 | `signup_closed` | sign-up is not open on this server |
| 404 | `not_found` | not there, **or belongs to another team** (the two look the same) |
| 409 | `conflict` | the thing changed since you read it, or already exists; for an optimistic-lock conflict `details.current` holds what the server has now |
| 429 | `rate_limited` | too many tries; `Retry-After` says how many seconds |
| 500 | `internal` | a bug; nothing more is said |

**Optimistic locking.** Anything with a `version` (tickets, docs, nodes) takes it in the body of the change. If it is stale the
answer is `409 conflict` with the current copy in `details.current`, and nothing is overwritten.

**Sessions.** The `wh_session` cookie is the same cookie the Next app sets (httpOnly, SameSite=Lax, Secure in production, 30
days), so a session started here works on `/api/v1` and the other way round. Every request resolves the person and their team
from it. Sign-in and sign-up answer with the person, their team and role, and the CSRF token.

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
3. Add the route to `API_ROUTE_AUDIT` in `src/lib/isolation.test.ts`, saying how it is scoped to the team. A route without an
   entry fails the test.
4. Contract tests in `tests/contract/*.app.contract.test.ts` (`pnpm test:contract --suite app --server-cmd "pnpm --filter
   @wheelhouse/api start"`): the happy path, signed out, another team's data, a stale `version`, and a forged request.
5. A method on `@wheelhouse/api-client`.

Pages also read data on the server, not only through actions (for example the dashboard, team, agents, admin, repositories and
map pages). Each page-port ticket needs `GET` endpoints for those reads too; they are not in the inventory because they are not
actions.

## Inventory of the 59 server actions

Every exported action in `src/app/actions.ts` has exactly one row (a test keeps it that way). "Owner" is the ticket that builds
the endpoint: WH-95 dashboard, team, agents, admin, new project, auth and invite pages; WH-96 board and ticket dialog; WH-97
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
| `suspendTeamAction` | `POST /api/app/admin/teams/:id/suspend` | WH-95 | instance admins only |
| `restoreTeamAction` | `POST /api/app/admin/teams/:id/restore` | WH-95 | instance admins only |
| `updateMember` | `PATCH /api/app/team/members/:userId` | WH-95 | owners only; role and tags |
| `removeMember` | `DELETE /api/app/team/members/:userId` | WH-95 | owners only |
| `changePassword` | `POST /api/app/me/password` | WH-95 | needs the current password |
| `createApiKey` | `POST /api/app/keys` | WH-95 | the secret is returned once, in this response only |
| `revokeApiKey` | `DELETE /api/app/keys/:id` | WH-95 |  |
| `setKeyDocsWriteAction` | `PATCH /api/app/keys/:id` | WH-95 | `{ docsWrite: boolean }` |
| `createProjectAction` | `POST /api/app/projects` | WH-95 | extends the GET already built; 201 |
| `createConceptFromDescriptionAction` | `POST /api/app/projects/:key/onboarding/concept` | WH-98 | onboarding wizard |
| `latestSeq` | none | unneeded | only fed the polling refresh; replaced by the SSE stream (WH-94) |
| `moveTicketAction` | `POST /api/app/tickets/:ref/move` | WH-96 | `{ column, index? , version? }`; the column by role or name, as in `move_ticket` |
| `createTicketAction` | `POST /api/app/projects/:key/tickets` | WH-96 | 201; also serves createTicketFromActionItemAction |
| `updateTicketAction` | `PATCH /api/app/tickets/:ref` | WH-96 | `version` in the body; a stale one is a 409 `conflict` with `details.current` |
| `deleteTicketAction` | `DELETE /api/app/tickets/:ref` | WH-96 |  |
| `getTicketAction` | `GET /api/app/tickets/:ref` | WH-96 | ticket, comments, linked nodes, history, pull requests |
| `commentAction` | `POST /api/app/tickets/:ref/comments` | WH-96 | 201 |
| `linkNodeAction` | `PUT /api/app/tickets/:ref/nodes/:nodeId` | WH-96 | DELETE on the same path unlinks (the `unlink` flag) |
| `getGraphAction` | `GET /api/app/projects/:key/graph` | WH-97 | nodes, edges, flows, decisions, terms |
| `upsertNodeAction` | `PUT /api/app/projects/:key/nodes` | WH-97 | create or update by id or name; `version` for the optimistic lock |
| `deleteNodeAction` | `DELETE /api/app/projects/:key/nodes/:id` | WH-97 |  |
| `saveLayoutAction` | `PUT /api/app/projects/:key/layout` | WH-97 | positions of many nodes in one call |
| `connectNodesAction` | `POST /api/app/projects/:key/edges` | WH-97 | `{ from, to, label?, kind }` |
| `deleteEdgeAction` | `DELETE /api/app/projects/:key/edges/:id` | WH-97 |  |
| `markFreshAction` | `POST /api/app/projects/:key/nodes/:id/fresh` | WH-97 |  |
| `upsertFlowAction` | `PUT /api/app/projects/:key/flows` | WH-97 | create or update |
| `deleteFlowAction` | `DELETE /api/app/projects/:key/flows/:id` | WH-97 |  |
| `upsertDecisionAction` | `PUT /api/app/projects/:key/decisions` | WH-97 | also used by the docs page to make an ADR from a decision record (WH-98) |
| `upsertTermAction` | `PUT /api/app/projects/:key/terms/:term` | WH-97 |  |
| `deleteTermAction` | `DELETE /api/app/projects/:key/terms/:term` | WH-97 |  |
| `askAction` | `POST /api/app/projects/:key/ask` | WH-97 | calls the Claude API from the server; the key never reaches the browser |
| `resolveDraftAction` | `POST /api/app/projects/:key/drafts/:id/resolve` | WH-97 | `{ action: "publish" | "discard" }` |
| `listDocsAction` | `GET /api/app/projects/:key/docs` | WH-98 | the doc tree |
| `getDocAction` | `GET /api/app/projects/:key/docs/:ref` | WH-98 |  |
| `createDocAction` | `POST /api/app/projects/:key/docs` | WH-98 | `{ title, body?, parent?, template? }`; 201 |
| `listDocTemplatesAction` | none | unneeded | not called by any page today; the five templates are static data the web app can ship |
| `createTicketFromActionItemAction` | `POST /api/app/projects/:key/tickets` | WH-98 | the same endpoint as createTicketAction (WH-96); the docs page then ticks the item with an ordinary doc update |
| `updateDocAction` | `PATCH /api/app/projects/:key/docs/:ref` | WH-98 | `version` in the body; 409 `conflict` with `details.current` |
| `markDocFreshAction` | `POST /api/app/projects/:key/docs/:ref/fresh` | WH-98 |  |
| `suggestDocAnchorsAction` | `GET /api/app/projects/:key/docs/:ref/anchor-suggestions` | WH-98 | a read |
| `moveDocAction` | `POST /api/app/projects/:key/docs/:ref/move` | WH-98 | `{ parent?, index?, version? }` |
| `deleteDocAction` | `DELETE /api/app/projects/:key/docs/:ref` | WH-98 |  |
| `linkDocNodeAction` | `PUT /api/app/projects/:key/docs/:ref/nodes/:nodeId` | WH-98 | DELETE on the same path unlinks |
| `resolveDocDraftAction` | none | unneeded | not called by any page today; if the docs UI needs it later, add `POST /api/app/projects/:key/doc-drafts/:id/resolve` |
| `listRepositoriesAction` | `GET /api/app/projects/:key/repositories` | WH-98 | also read by the docs anchor picker |
| `createRepositoryAction` | `POST /api/app/projects/:key/repositories` | WH-98 | any teammate (as before); 201 |
| `connectGithubRepositoryAction` | `POST /api/app/projects/:key/repositories/github` | WH-98 | owners only; the installation must be the team's own (ADR-12); name and branch are read from GitHub |
| `updateRepositoryAction` | `PATCH /api/app/projects/:key/repositories/:id` | WH-98 | any teammate (as before) |
| `retireRepositoryAction` | `POST /api/app/projects/:key/repositories/:id/retire` | WH-98 | any teammate (as before) |
| `browseRepoTreeAction` | `GET /api/app/projects/:key/repositories/:id/tree` | WH-98 | for the anchor picker |
| `markAllSeenAction` | `POST /api/app/agents/mark-all-seen` | WH-95 | `{ keyId?, projectKey? }`; also used by the bots menu on the board (WH-96) |
| `removeSessionAction` | `DELETE /api/app/projects/:key/sessions/:sessionId` | WH-95 | built with the dashboard, whose agents widget uses it; the board's bots menu (WH-96) calls the same endpoint |

## Built by WH-95

The reads the pages make (not actions, so not in the inventory), and the endpoints from the inventory above that belong to this
ticket. Anything not marked public needs a session.

| Endpoint | What it is |
|---|---|
| `GET /api/app/team` | the team page: members with roles and tags, seats, and (owners only) the pending join invites |
| `GET /api/app/agents` | the Agents page: the team's keys (name, prefix, last used, `canWriteDocs`; never a key value) and the printed setup commands |
| `GET /api/app/invites?kind=join_team\|new_team` | pending invites. `new_team` is for instance admins; anyone else gets a 404 |
| `GET /api/app/admin/teams`, `GET /api/app/admin/teams/:id` | instance admins only; anyone else gets a 404. Names, emails and counts, never what a team wrote |
| `GET /api/app/dashboard/:widget` | one dashboard widget's data: `kpis`, `progress`, `throughput`, `activity-split`, `agents`, `attention`, `recent`, `sync`. An unknown widget is a 404 |
| `POST /api/app/invites/peek`, `POST /api/app/invites/accept` | **public** (no session; the CSRF token is `anonymous`), rate limited per address (30 tries per 15 minutes) |

Rules worth knowing:

- **Secrets are returned once.** `POST /api/app/keys` answers `{ key, secret }`; `POST /api/app/invites` answers `{ ..., link }` with the
  token in the link's `#fragment`. No later response contains either, and the client never needs to ask.
- **Limits live in core**, with the rules: 10 keys an hour and 20 invites an hour per person, 30 invite lookups per 15 minutes per address.
  A limit answers `429 rate_limited` with `Retry-After`.
- **Not found beats forbidden across teams.** Another team's member, key or invite is a 404 on every endpoint; only the same team's
  non-owner gets a 403.
- **Every bad invite link reads the same** (`400 invalid`, "This invite link is invalid or has expired."), so a link cannot be probed.
- The dashboard's widgets are separate requests so each one paints as soon as its own data arrives. They do not share a snapshot the
  way the Next app's single render did; if that matters under load, memoise per request in `@wheelhouse/core/lib/metrics` (`setRequestMemo`).

## Built by WH-96

The board and the ticket dialog. Everything needs a session. A ticket is addressed by its ref (`WH-12`, case-insensitive in the key), which already names its project, and a ticket or project of another team is a 404.

| Endpoint | What it is |
|---|---|
| `GET /api/app/projects/:key/board` | the project page in one read: `project`, `columns` (id, name, role, position), `tickets` (with `nodeIds` and `commentCount`), `nodes` (just id, name, kind, parentId, layer), `members` (id, name) and the setup `checklist` |
| `GET /api/app/projects/:key/queue` | the Bots menu: `{ bots }`, each agent key with its queue depth and live sessions in this project |
| `PATCH /api/app/tickets/:ref` | see "The version check" below |
| `POST /api/app/tickets/:ref/move` | `{ column, index?, version? }`: the column by id, name or role; `index` is the place in the column (the end when absent) |

A ticket in every answer has the same fields (`id`, `ref`, `number`, `title`, `body`, `columnId`, `priority`, `assigneeId`, `agentClaimable`, `claimedByKeyId`, `labels`, `position`, `version`, `createdByKind`, `createdAt`, `updatedAt`) and no internal ids. Create and move also say the column's `name`.

**Claiming.** Only agents claim a ticket (over MCP or `/api/v1`). A person decides whether agents may pick a ticket up (`agentClaimable`) and sees whether one has (`claimedByKeyId`); there is no web endpoint to claim.

**Input is checked like the MCP tools check it.** A wrong type is a 400 whose `details.fields` names the field: text for `title`/`body`/`column`, one of `low|medium|high|urgent` for `priority`, a list of text for `labels`, true or false for `agentClaimable`, a whole number for `version` and `index`. Unknown fields are ignored. An assignee must belong to the caller's team.

### The version check

The first real use of the optimistic-lock pattern described under "Optimistic locking" above.

- `PATCH` and `move` take `version`: the version you last read. If anyone (a person or an agent) changed the ticket since, the answer is `409 conflict`, nothing is changed, and `details.current` is the ticket as it is now, in the same trimmed shape (`ApiError.current` in the client).
- Two edits made from the same version: exactly one is applied and the other is a 409 (tested with two requests at once).
- Without `version` the change is applied over whatever is there, as the agents' own tools do. The web app always sends it for edits and not for moves made by dragging, because a drag is about position, not about what the ticket says.
- A change that alters nothing does not bump the version.

### Live updates

A change made by an agent over MCP or `/api/v1`, or by anyone through these endpoints, is one write path: it publishes an event on the project's stream (`/api/projects/:key/stream`) after it commits. A test holds a stream open, moves a ticket as an agent, and requires the `change` event within a second.

## Built by WH-97

The map, decisions, glossary and activity pages. Everything needs a session. A project, node, edge, flow, decision, term or draft of another team is a 404.

| Endpoint | What it is |
|---|---|
| `GET /api/app/projects/:key/graph` | the whole map in one read: `nodes`, `edges`, `ticketLinks`, `flows`, `decisions`, `terms`, `flux` (nodes whose code is being changed right now, with the map updates waiting for it) and `askEnabled`. The decisions and glossary pages read the same endpoint |
| `PUT /api/app/projects/:key/nodes` | create (no `id`) or change (`id`) a node; `{ name, layer, kind, status, parent, summary, purpose, responsibilities, interfaces, gotchas, details, anchors, columns, indexes, version }` |
| `PUT /api/app/projects/:key/layout` | `{ positions: [{ id, x, y, width?, height? }], placed? }`: a drag, a resize or a Tidy. `placed: false` is a whole-lens Tidy |
| `POST /api/app/projects/:key/edges` | `{ from, to, label?, kind? }`; `depends` (default) or `implements`. Answers 200 with the edge, new or existing. References between tables are made with a column's `references` |
| `PUT /api/app/projects/:key/flows` | `{ id?, name, description?, steps?: [{ node, title, detail? }], version? }`; steps are replaced wholesale |
| `PUT /api/app/projects/:key/decisions` | without `number` a new ADR; with it, that ADR is changed |
| `PUT/DELETE /api/app/projects/:key/terms/:term` | the term is named in the path (URL-encode it); `PUT` takes `{ definition, node? }`; `DELETE` takes the term's name or id |
| `POST /api/app/projects/:key/nodes/:id/fresh` | "still accurate": clears the stale flag without changing what the node says |
| `POST /api/app/projects/:key/drafts/:id/resolve` | `{ action: "publish" \| "discard" }` |
| `POST /api/app/projects/:key/ask` | `{ question, focus? }` → `{ answer, truncated }` |
| `GET /api/app/projects/:key/activity?who=agent\|human` | the last 200 events, newest first; `data` is only `ref`, `number` and `body` (cut at 500 characters) |

**Locks on nodes, flows and decisions.** These carry a `version` but nothing checked it before: not the old app, and not the agents' MCP tools (only tickets and docs had a lock). The web endpoints take `version` and use the same pattern as tickets: a change made since is a `409 conflict`, nothing is overwritten, and `details.current` is the entity as it is now (`ApiError.current`). The check is an optional `expectedVersion` on the service functions; the MCP tools never pass it, so agents behave exactly as before. Two edits from the same version give exactly one 200 and one 409.

**Ask the map spends money and calls out**, so: the project is resolved first (another team's is a 404 before anything is counted or called), then at most 20 questions per person per 10 minutes (`429` with `Retry-After`), then the server calls Claude with its own key. The key is read from the server's environment and is in no response, header or cookie (the contract suite checks that, including when Claude fails). Claude's own errors become plain reasons ("Claude is rate limited, try again in a moment", "ANTHROPIC_API_KEY is invalid", "Claude API error (500)"), never the upstream body. The contract suite runs Ask against a fake Claude server (`tests/contract/lib/fake-github.ts`) that answers from what it was sent.

**In flux and drafts.** When an agent's session is changing a node's files and the agent edits that node, the edit is stored as a draft and published when the code lands. `flux` in the graph lists those sessions and drafts per node; `resolve` publishes or discards one by hand.

**Renaming a term** is a delete of the old name and a define of the new one, as before (terms are keyed by name), so it is two calls.

## Built by WH-98

The docs, repositories and onboarding pages. Everything needs a session. A project, doc, map node or repository of another team is a 404.

| Endpoint | What it is |
|---|---|
| `GET /api/app/projects/:key/docs` | the tree (`docs`: id, parent, slug, title, version, position, updatedAt, stale) and what the page's panels offer: `nodes` to link, `decisions` to link, `members` (who wrote what) |
| `GET /api/app/projects/:key/docs/:ref` | one doc (a doc's id, or its slug) with the map nodes it is linked to. Only what the page shows: the internal freshness columns are not sent |
| `POST /api/app/projects/:key/docs` | `{ title, body?, parent?, template? }`; 201. A `template` (`spec`, `decision-record`, `runbook`, `meeting-notes`, `onboarding`) fills the body when none is given |
| `PATCH /api/app/projects/:key/docs/:ref` | `{ title?, body?, anchors?, version? }`; with `version`, a doc changed since is a `409 conflict` and `details.current` is the doc now. Editing text or anchors clears the stale flag |
| `POST /api/app/projects/:key/docs/:ref/fresh` | "still accurate" |
| `GET /api/app/projects/:key/docs/:ref/anchor-suggestions` | `{ anchors }`: path-like words in the text and the anchors of the linked nodes |
| `POST /api/app/projects/:key/docs/:ref/move` | `{ parent?, index?, version? }`; `parent: null` is the top level; cycles are refused |
| `DELETE /api/app/projects/:key/docs/:ref` | the doc and the docs nested under it |
| `PUT/DELETE /api/app/projects/:key/docs/:ref/nodes/:nodeId` | link / unlink a map node |
| `GET /api/app/projects/:key/repositories` | `{ repositories }`: a view without installation or GitHub ids; `browsable` says a GitHub repository's tree can be fetched |
| `POST /api/app/projects/:key/repositories` | `{ displayName, role, provider?, defaultBranch?, pathLimit?, lifecycle? }`; 201 |
| `PATCH /api/app/projects/:key/repositories/:id` | any of the same fields (`pathLimit: null` clears it) |
| `POST /api/app/projects/:key/repositories/:id/retire` | |
| `GET /api/app/projects/:key/repositories/github` | the Connect GitHub card: `configured`, `missing` (settings to set; owners only), `isOwner`, and for owners each installation of the team with the repositories this project could still connect. GitHub is asked on every read |
| `POST /api/app/projects/:key/repositories/github` | `{ installationId, repoId, role?, pathLimit? }`; 201. Owners only; the installation must be the team's own (ADR-12); the name and default branch are read from GitHub, not the request |
| `GET /api/app/projects/:key/repositories/:id/tree` | `{ files, truncated }` for the doc anchor picker; only for a GitHub repository of the person's own project |
| `GET /api/app/projects/:key/onboarding` | the wizard: the project, `hasRepos`, and the commands to paste (with this project's key; never an API key) |
| `POST /api/app/projects/:key/onboarding/concept` | `{ description }`: the "no code yet" path; becomes the map's first concept. An empty one is a 400 on `description` |

Creating, editing and retiring repositories is open to any teammate, as it was in the Next app (the inventory above first said "owners only"; the code never checked it). Connecting GitHub is owners only.

**The Connect GitHub redirects are unchanged.** `/api/github/install` and `/api/github/callback` are the same Nest routes as before and send the person back to `/p/KEY/repos?github=connected` (or `github_error=...`), which the React page turns into the same notes. The GitHub App's settings and callback URL need no change.

**Connecting a repository** used to be a form that redirected to `?github=repo_connected`; it is now a fetch, and the page shows "Repository connected." (or the server's reason) on that installation and reads the list again. The words are the same.

**An action item becomes a ticket** through `POST /api/app/projects/:key/tickets` (WH-96), then the page ticks the box with an ordinary `PATCH` of the doc against the version it read. "Create ADR from this doc" is `PUT /api/app/projects/:key/decisions` (WH-97).

## Built by WH-105: who can open a project (ADR-23)

A project is reachable only by its members. Every route below is for a signed-in person; an agent key cannot call them. A project you are not in, and a project of another workspace, are the same plain `404`; a member whose role is too low gets `403`.

| Endpoint | Notes |
|---|---|
| `GET /api/app/projects` | now only the projects the person is a member of (an agent key still sees its whole workspace) |
| `POST /api/app/projects` | workspace viewers and guests get `403`; the creator becomes the project's admin |
| `GET /api/app/projects/:key/members` | `{ project, myRole, members: [{ userId, name, email, role, workspaceRole, addedAt }] }`. Any member |
| `GET /api/app/projects/:key/members/addable` | `{ people }`: workspace members not yet in the project. Project admins |
| `POST /api/app/projects/:key/members` | `{ userId, role }` with role `admin`, `editor` or `viewer`; 201. Project admins; the person must be in the workspace; already in is a `409` |
| `PATCH /api/app/projects/:key/members/:userId` | `{ role }`. Project admins; the last admin cannot be demoted (`409`) |
| `DELETE /api/app/projects/:key/members/:userId` | remove someone, or leave yourself. The last admin cannot go (`409`) |
| `POST /api/app/projects/:key/join` | a workspace owner or admin joins as the project's admin. Audited, and shown in the project's own activity |
| `GET /api/app/access/projects` | every project of the workspace by name with its admins and whether you are in it. Workspace owners and admins |
| `GET /api/app/access/audit?project=KEY&limit=` | the access audit log, newest first. Workspace owners and admins |

Workspace roles are now `owner`, `admin`, `member`, `viewer` and `guest`. Owners and admins invite, change roles and remove members (`/api/app/team/...`, `/api/app/invites`); only an owner can make, change or remove an owner. Removing a person who is the only admin of a project is a `409` that names the projects. `/api/v1` and `/mcp` are unchanged: an agent key keeps the access it had.

**More from WH-105.**

| Endpoint | Notes |
|---|---|
| `GET /api/app/projects` | each project now carries `role`, the caller's own role in it |
| `POST /api/app/invites` | join invites take `projects: [{ project: "KEY", role }]`; the caller must administer each one (`403` otherwise); at most 20. A pending invite lists them under `projects` |
| `POST /api/app/invites/peek-existing` | signed in: what an invite sent to your own address would add you to. Anyone else's invite, or a bad token, is the usual `400` |
| `POST /api/app/invites/accept-existing` | signed in: join that workspace with the account you have (you keep your other workspaces); this session then works in it. Already a member is a `409` and the invite stays unused |
| `GET /api/app/me/workspaces` | `{ workspaces: [{ id, name, role, active }] }`; a suspended workspace is left out |
| `POST /api/app/me/workspace` | `{ teamId }`: this session works in another of your workspaces. Not yours, suspended or malformed is a `404`. Only this session changes; every cached read in the browser belongs to the old workspace and is dropped |

A person who belongs to several workspaces works in one at a time, chosen per session (`sessions.active_team_id`; null means their first). Addresses do not carry the workspace (`/w/<slug>/...` is not built): two tabs of one session are in the same workspace. A workspace an instance admin suspended is never chosen; someone is locked out only when every workspace of theirs is suspended. Open event streams re-check access every 15 seconds: a project stream ends when its person is removed, and the dashboard stream follows joins and removals.

**Wording.** The product says "workspace" where the code says "team" (tables, ids, URLs such as `/team` and `/api/app/team` are unchanged). Messages shown to people were reworded; messages that are part of the frozen `/api/v1` and `/mcp` contract were not.

## Built by WH-107: a dashboard for each project

`GET /api/app/dashboard/:widget` now takes an optional `?project=KEY`. Without it the widgets read the whole workspace, limited to the projects the person is in (as before). With it they read that one project: the project is resolved through `getProject`, so another workspace's project, one the person is not in, a malformed value or a repeated `project` parameter is a `404`, and the numbers come from a snapshot limited to that project. An empty `?project=` means the workspace.

| Widget | For one project |
|---|---|
| `kpis`, `progress`, `throughput`, `activity-split`, `attention`, `recent`, `sync` | the same shapes, for that project only. `kpis` gained `agentsActive7d` (agents that changed something in the project in 7 days) |
| `agents` | only the agents that do something in that project (pending changes, actions in 7 days or a live session) |
| `focus` | **project only** (`404` without `?project=`): what has waited longest for review, what has sat longest in progress, agents gone quiet, decisions still proposed, member count and the caller's role. "How long" is time since the ticket last moved into its column |

The page is `/p/:key/overview` ("Overview", first in the project sidebar). It draws the same widget components as the home page, inside a scope that says which project (`lib/dashboard-scope`), so a widget added to `PROJECT_WIDGETS` in `pages/dashboard/registry.tsx` appears on every project's Overview. It stays live through the project's own event stream (opened by the project layout) and a 30 s tick. The home page's project rows link to it.
