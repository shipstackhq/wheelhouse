# Workspaces: the top level, switching, and agencies (plan)

Status: 2026-10-26, branch `wh/workspaces`. All phases built (uncommitted); see Progress.

## Progress

- [x] Phase 1: workspace per request and in URLs
  - Leftover: internal links in rendered markdown (`markdown.tsx`) are not prefixed
  - Note: old unprefixed URLs (`/t/WH`) are not redirected (dev only)
- [x] Phase 2: switcher, create, personal workspace
  - Leftover: "rest by last used" order (needs a per-workspace last-used column); unread dot (needs API); Ctrl/Cmd+K (no palette)
- [x] Phase 3: guests and transfer
  - Leftover: the new owner only sees an offer on the workspace settings page (no inbox notification)
  - Leftover: accepting demotes every other owner to admin (co-owners not kept)
  - Leftover: root `pnpm lint` fails on vendored `temp/` files (add `temp/` to ESLint ignores)
- [x] Phase 4: GitHub many-to-many
  - Leftover: no web UI calls the new unlink endpoint (`DELETE /api/app/teams/:key/repositories/github/:installationId`)
  - Leftover: the `github_error=taken` web message is dead
  - Done in Phase 6: isolation suite has 2 failing audit tests (files and routes from notifications, broadcasts, projects, cycles, images, transfer lack audit entries); most predate this plan (notifications, broadcasts, projects, cycles, images), but the create-workspace and the four transfer routes (Phases 2 and 3) are ours and need entries
- [x] Phase 5: devices per person
  - Leftover: runs already offered or running from a workspace the person then leaves are not cancelled
  - Leftover: the daemon change is in `wheelhouse-cli/daemon`, outside this repo and uncommitted
  - Note: any signed-in person can pair a device (the old viewer/guest refusal is gone)
- [x] Phase 6: check and hand over (automated checks green; the by-hand checks below are the user's)
  - Isolation suite: audit entries added, `X-Workspace` case added (service level, no HTTP helper in the suite)

## Decision: two levels, like GitHub and Linear

The **workspace is the top level**: the tenant root, the billing unit and where integrations attach. There is no org above it. In GitHub terms a
workspace is an org; we keep the word "workspace" (as Linear does).

```
person ──< membership (role) >── workspace ──< team ──< project, issues, map, docs
                                     │
                                     ├── billing (later), settings, API keys, integrations
                                     └── devices (per person, see below)
```

Why not org → workspace → team: a workspace already holds members, roles, teams, settings, keys and integrations. A level above it makes every
rule ask "on which level?" (members, roles, settings, keys, devices, agent pins, billing). GitHub and Linear serve agencies with two levels.
A third level is only needed if one paying customer wants several fully separate areas with separate members; workspaces are self-contained,
so an org can be put above them later if that happens.

## Who it is for

| Who                               | Shape                                                                                                                                                                                                                                                 |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Solo developer                    | One **personal workspace**, made at sign-up, never asked about. The switcher stays out of the way                                                                                                                                                     |
| Small team                        | One workspace, a few teams                                                                                                                                                                                                                            |
| Agency (the Linear request below) | Each **client owns its own workspace** (so it can be handed over). Agency staff are members of many workspaces and switch between them all day; client staff are members of their own only. Agency staff who only help on one team join as **guests** |
|                                   |                                                                                                                                                                                                                                                       |

The agency case comes from a Linear user (a 90-person services company) who could not connect one Slack workspace to the many client Linear
orgs they work in, and asked for the link to be per Slack channel. Two lessons: clients own their space, and integrations must link
many-to-many, per channel or repository, never "this workspace = that Slack or GitHub".

## What exists today

- Memberships with roles `owner`, `admin`, `member`, `viewer`, `guest` (ADR-23). A role never opens a team by itself; `team_members` does.
- The active workspace is stored **on the browser session** (`sessions.active_workspace_id`); every request uses it. Switching
  (`POST /api/app/me/workspace`) changes it, then the web app clears its cache and goes to `/`.
- URLs carry no workspace (`/t/WH`, `/chat`, `/agents`). `workspaces.slug` exists for `/w/<slug>` "later".
- Team keys are unique **per workspace** only.
- New workspaces come only from invites (`new_workspace`); there is no "create a workspace" for a signed-in person.
- A GitHub App installation belongs to **one** workspace (`github_installations.installation_id` is the primary key): the same limitation
  the Linear user hit, for GitHub.
- Devices belong to one workspace (pairing picks it).

### The bug this fixes

Two tabs share one session. Switching in tab A silently moves tab B, whose page still shows the old workspace. Its next action is resolved
in the new workspace, and because team keys repeat across workspaces (`WH` in both), it can **write to the wrong workspace**. Workspace
state must belong to the URL and the request, not the session.

## The design

### 1. The workspace in the URL and on every request

- Every page that belongs to a workspace lives under **`/w/:slug/...`**: `/w/acme/t/WH`, `/w/acme/inbox`, `/w/acme/agents`.
  The `/w/` prefix avoids clashes between slugs and app routes (`/login`, `/settings`).
- Pages about the person stay outside: `/settings/profile`, `/settings/password`, `/settings/devices`, `/login`, `/invite`.
- The web client sends the workspace on every API call as a header, `X-Workspace: <slug>`, set by one function in `packages/api-client`
  from the current URL. The server resolves the membership **per request** from that header (session auth) and refuses a workspace the
  person is not in with `not_found`. Agent keys ignore it: a key already belongs to one workspace.
- `sessions.active_workspace_id` becomes **last used**: `/` redirects to `/w/<last used>/`. It never decides which workspace a request is for.
- Query keys in the web app start with the workspace slug, so switching drops nothing it does not have to and two workspaces never mix.
- The live stream is opened per workspace (`/api/stream` with the header or `?workspace=`).

Result: each tab works in its own workspace; links work for anyone with access; the wrong-workspace bug cannot happen.

### 2. Switching

- The switcher lists the person's workspaces (personal first, then the rest by last used), with role, an unread dot from the inbox, and
  **Create workspace**. Choosing one navigates to `/w/<slug>/` (the same page there if it exists, else the board home).
- Keyboard: `Ctrl/Cmd+K` → "Switch workspace", and `Ctrl/Cmd+1…9` for the first nine.
- Suspended workspaces are listed greyed with the reason, not hidden.

### 3. Personal workspace and creating workspaces

- Sign-up makes a personal workspace (`kind: personal`, named after the person, slug from their name). It is a normal workspace in every
  other way, so a solo developer can later invite people into it and it simply becomes a team workspace (`kind` → `team`).
- **Create workspace** for any signed-in person: name and slug; they become its owner. (Instance admins can limit this; invites keep working.)

### 4. Members, guests, seats

- `owner`, `admin`, `member`, `viewer` as today. **`guest`**: sees only the teams they are put on, cannot see the member list or other
  teams, cannot create teams. This is the agency person helping on one client team, and the client stakeholder in an agency's workspace.
- Seats (for billing later) count `owner`, `admin`, `member`; guests and viewers are free up to a limit. Counted per workspace, once per person.

### 5. Ownership transfer

- **Transfer workspace**: the owner names another member as owner (they accept). Billing follows the owner when billing exists. This is the
  agency handing a client's workspace over at the end of a build.

### 6. Integrations link many-to-many

- **GitHub**: one App installation can serve several workspaces. `github_installations` becomes a link table keyed by
  `(installation_id, workspace_id)`; each workspace picks which of the installation's repositories it uses (already per repository). The
  proof step (the installing person administers the installation) stays per link.
- **Slack (when built)**: one Slack workspace connects to many Wheelhouse workspaces, and the link is **per Slack channel**
  (channel → workspace and team or project). Designed this way from the start.
- General rule: an integration link is a row on the Wheelhouse side (workspace, team or project → external account, channel or repo),
  never a one-to-one mapping between accounts.

### 7. Devices across workspaces

- A device belongs to **the person**, not a workspace, and can serve every workspace they are a member of (no re-pairing per workspace).
  Each run and chat names its workspace; the server only offers a device work from workspaces its owner is in, and drops the device from a
  workspace when the person leaves it.
- Pairing no longer asks for a workspace. The Devices page stays under the person's settings.

### 8. Settings by level

| Setting                                                                                 | Level                         |
| --------------------------------------------------------------------------------------- | ----------------------------- |
| Name, slug, icon, members, roles, API keys, integrations, `agentsEnabled`, catalog pins | Workspace                     |
| Statuses, cycles, team agents                                                           | Team                          |
| Profile, password, devices, notification preferences                                    | Person                        |
| Billing (later)                                                                         | Workspace, owned by the owner |

## Phases

Each phase ends with its tests passing. Phase 1 is the large one; the rest are small and mostly parallel after it.

### Phase 1: workspace per request and in URLs (api + api-client + web). Sonnet; split by area if large.

- api: resolve the workspace from `X-Workspace` per request (session auth); membership check; `not_found` for others; session's workspace
  becomes last used; the stream takes the workspace.
- api-client: one place that sets the header from the current workspace.
- web: routes under `/w/:slug`, `/` redirect, query keys prefixed with the slug, links updated, `useWorkspace()` hook.
- Tests: two workspaces with the same team key, two "tabs" (two clients on one session) working in different workspaces at once, every
  write lands in its own; a workspace the person left is `not_found`; isolation suite extended for the header.

### Phase 2: switcher, create, personal workspace (web + api). Sonnet.

- Switcher as above, Create workspace, personal workspace at sign-up, `kind` column, slug rules (lowercase, unique, reserved words).
- Tests: sign-up makes one personal workspace; create and switch; slug clashes refused.

### Phase 3: guests and transfer (api + web). Sonnet.

- Guest rules enforced in the team access layer (`lib/team-access.ts`), member list hidden from guests; transfer with acceptance.
- Tests: a guest sees only their teams and no members; transfer moves ownership only after acceptance.

### Phase 4: GitHub many-to-many (api). Sonnet.

- `github_installations` → `(installation_id, workspace_id)`; the proof per link; repositories still chosen per workspace.
- Tests: one installation linked to two workspaces, each with its own repositories; unlinking one leaves the other.

### Phase 5: devices per person (api + daemon). Sonnet.

- `devices.workspace_id` removed, device scoped to its owner; offers carry the workspace; offers only from the owner's workspaces;
  pairing without a workspace; the daemon's config drops `workspace`.
- Tests: one device runs jobs from two workspaces; leaving a workspace stops offers from it; the isolation suite for devices and jobs.

### Phase 6: check and hand over.

- Typecheck, lint, all suites. By hand: two tabs in two workspaces with the same team key, switch in one, act in the other; create a
  workspace; open a link from another workspace; a guest's view.

## Out of scope

Billing and payments, Slack (only its link model is fixed here), an org level above workspaces, SSO.

## Open questions

- Header (`X-Workspace`) or path prefix for the API (`/api/w/:slug/...`)? The plan picks the header: one change in the client, no route
  rewrites on the server.
- Can anyone create workspaces, or only paying owners and instance admins?
- Guests free up to what limit?
- Do agency staff need a cross-workspace view ("my issues in every workspace")? Useful, but not in this plan.
