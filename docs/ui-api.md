# The web app's API (`/api/app/*`)

The React app talks to the NestJS API through this API. It replaces the Next app's 59 server actions (`src/app/actions.ts`) and
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
| `createRepositoryAction` | `POST /api/app/projects/:key/repositories` | WH-98 | owners only; 201 |
| `connectGithubRepositoryAction` | `POST /api/app/projects/:key/repositories/github` | WH-98 | owners only; the installation must be the team's own (ADR-12); name and branch are read from GitHub |
| `updateRepositoryAction` | `PATCH /api/app/projects/:key/repositories/:id` | WH-98 | owners only |
| `retireRepositoryAction` | `POST /api/app/projects/:key/repositories/:id/retire` | WH-98 | owners only |
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
