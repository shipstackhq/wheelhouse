# Deploying Wheelhouse on a VPS

Wheelhouse ships as one container (`ghcr.io/shipstackhq/wheelhouse`). The NestJS API and the React app are the
same process: the image holds the API and the built web app, and the API serves both on one port (`/api`, `/mcp` and
the webhook are the API; every other address is a page of the app). One container means one origin, so there is no CORS to
configure and the session cookie and the CSRF check see the same host.

There are two ways to run it:

- **On a VPS that already has Postgres and Caddy** (what the rest of this guide describes): `docker-compose.yml` holds only
  the app. It uses the Postgres and the Caddy already on the server.
- **On a machine with nothing on it**: `docker-compose.standalone.yml` adds Postgres and Caddy. See
  *A machine with nothing on it* below.

The public paths, environment variables and health check (`GET /api/health`) are the same as before the move to
NestJS and React, so the Claude Code plugin, the CLI, the GitHub App and existing API keys need no change.

```
browser / Claude Code ──https──▶ host Caddy ──▶ 127.0.0.1:3000  wheelhouse app (container)
                                                       │ docker network
                                                       ▼
                                            existing Postgres container (database "wheelhouse")
```

Updates are automatic: a push to `main` runs CI, then `deploy.yml` builds the image, tags it with the commit
SHA and pushes it to GHCR. It then SSHes to the server with a key that can run **one thing only**: a root-owned
wrapper (`/usr/local/sbin/deploy-wheelhouse`). The workflow sends the SHA, the GitHub user and the job's token to
the wrapper on stdin; the wrapper logs in to GHCR, runs `deploy.sh` in the app directory and logs out. The script
dumps the database, swaps the image, waits for `/api/health`, and **puts the previous image back if the new one is
not healthy**. It cannot undo a migration, which is why it dumps first.

**The workflow uploads nothing.** `docker-compose.yml`, the `deploy/*.sh` scripts and `.env` live on the server
(root-owned, in `/opt/apps/wheelhouse` here), so a change to compose or a script reaches the server only when you
copy it (see *Updating the compose file or scripts*). Deploys only change the image tag.

## A machine with nothing on it

For a trial, a home server, or any host without a Postgres and a proxy. Docker with the Compose plugin is all it needs.

```bash
git clone https://github.com/shipstackhq/wheelhouse && cd wheelhouse
cp .env.standalone.example .env     # set POSTGRES_PASSWORD, APP_URL and SITE_ADDRESS (see the file)
docker compose -f docker-compose.standalone.yml up -d --build
```

`--build` builds the image from the checkout (a few minutes the first time). Once an image of this version is published to GHCR
you can leave it out and Compose pulls it instead.

Open `APP_URL` and create the first account straight away (see *First deploy*). With `SITE_ADDRESS` set to a domain name that
points at the machine (ports 80 and 443 reachable), Caddy gets a certificate for it by itself; with `:80` it speaks plain HTTP,
which is fine for a trial on one machine (`APP_URL=http://localhost`). The other settings in `.env.example`
(`ALLOW_SIGNUP`, `ADMIN_EMAILS`, the seat and invite limits, `ANTHROPIC_API_KEY`, the GitHub App) go in the same `.env`.

To update, `git pull` and run the `up -d --build` command again (or `pull` and `up -d` with a published image). Postgres lives in the `pgdata` volume, so
`down` keeps the data and `down -v` deletes it. Back it up with `deploy/backup.sh`: copy `backup.sh` and `restore.sh` into a
folder with a `.env` that names the Postgres container (`PG_CONTAINER=wheelhouse-postgres-1`, `PG_DUMP_USER=wheelhouse`,
`PG_DB=wheelhouse`). The image is built from this repository's `Dockerfile` (`docker compose ... build app`), or pulled from GHCR.

## One-time server setup

Run on the VPS. Names in `CAPS` are yours to choose.

**1. Database and role** (replace the password; `PG_CONTAINER` is your Postgres container's name and `PG_SUPERUSER` its admin user, the same value as `PG_DUMP_USER` below):

```bash
docker exec -it PG_CONTAINER psql -U PG_SUPERUSER -d postgres -c "create role wheelhouse login password 'STRONG_PASSWORD'"
docker exec -it PG_CONTAINER psql -U PG_SUPERUSER -d postgres -c "create database wheelhouse owner wheelhouse"
docker inspect PG_CONTAINER --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}}{{"\n"}}{{end}}'   # the network name
```

The role owns only its own database, so it cannot read the other apps' data.

**2. App directory, deploy key and wrapper**

```bash
sudo mkdir -p /opt/apps/wheelhouse/backups && cd /opt/apps/wheelhouse
# copy docker-compose.yml, deploy.sh, backup.sh, restore.sh here from your machine (see below), then:
sudo chmod 755 deploy.sh backup.sh restore.sh
```

Create the key pair on your machine (`ssh-keygen -t ed25519 -f deploy_key -C github-deploy`). The private half
goes into GitHub (below). The public half goes into `authorized_keys` of the SSH user (root here, because
the wrapper runs `docker`) **locked to the wrapper**, so a leaked key can do nothing else:

```
command="/usr/local/sbin/deploy-wheelhouse",restrict ssh-ed25519 AAAA... github-deploy
```

`/usr/local/sbin/deploy-wheelhouse` (root-owned, mode 755):

```bash
#!/usr/bin/env bash
set -euo pipefail
APP_DIR=/opt/apps/wheelhouse
IMAGE_REPO=ghcr.io/shipstackhq/wheelhouse
read -r sha; read -r ghuser; read -r token
[[ $sha =~ ^[0-9a-f]{40}$ ]]     || { echo "bad sha"; exit 2; }
[[ $ghuser =~ ^[A-Za-z0-9-]+$ ]] || { echo "bad user"; exit 2; }
trap 'docker logout ghcr.io >/dev/null 2>&1 || true' EXIT
printf '%s' "$token" | docker login ghcr.io -u "$ghuser" --password-stdin >/dev/null
cd "$APP_DIR"
IMAGE="$IMAGE_REPO:$sha" ./deploy.sh
```

The token only lives for the workflow run and is removed on exit, so no registry password is stored.

**3. `/opt/apps/wheelhouse/.env`** (copy `.env.example` and fill it in):

| Variable | Value |
|---|---|
| `APP_URL` | `https://wheelhouse.example.com` |
| `DATABASE_URL` | `postgres://wheelhouse:STRONG_PASSWORD@PG_CONTAINER:5432/wheelhouse` |
| `POSTGRES_NETWORK` | the network from step 1 |
| `WHEELHOUSE_PORT` | `3000` (or any free port; Caddy points here) |
| `PG_CONTAINER`, `PG_DB`, `PG_DUMP_USER` | container name, `wheelhouse`, the Postgres admin user (used by the dump and restore) |
| `ALLOW_SIGNUP` | `false` (keep it: people join through invite links) |
| `ADMIN_EMAILS` | your email; only these accounts can invite someone into a brand new team |
| `MAX_TEAM_MEMBERS`, `INVITE_TTL_HOURS` | optional: seats per team including the owner (default 5), link lifetime in hours (default 168) |
| `RCLONE_REMOTE` | optional, off-box backup target, see Backups |

`chmod 600 .env`. `WHEELHOUSE_IMAGE` is written by the deploy script.

**4. Caddy**: add a site block to the existing Caddyfile and reload (`sudo systemctl reload caddy`). `deploy/Caddyfile` in the
repository is the tested version of this (the standalone stack uses it as it is):

```
wheelhouse.example.com {
    # Live updates are server-sent events: straight through, never buffered or compressed.
    @streams path /api/stream /api/projects/*/stream
    handle @streams {
        reverse_proxy 127.0.0.1:3000 {
            flush_interval -1
        }
    }
    handle {
        encode zstd gzip
        reverse_proxy 127.0.0.1:3000 {
            flush_interval -1
        }
    }
}
```

Caddy sets `X-Forwarded-For` itself; the app's rate limits use it, so do not turn that off and do not put another proxy that
adds its own entries behind it (see *Rate limits and the proxy*). If Caddy runs in Docker instead of on the host, join the app
to Caddy's network and use `reverse_proxy wheelhouse-app:3000`.

## GitHub configuration

Repository **Settings → Environments → New environment: `production`** (add required reviewers there if you
want a manual approval before every deploy). In that environment:

| Kind | Name | Value |
|---|---|---|
| Secret | `DEPLOY_HOST` | server address |
| Secret | `DEPLOY_USER` | the SSH user the key belongs to (`root` here) |
| Secret | `DEPLOY_SSH_KEY` | the private key from step 2 |
| Secret | `DEPLOY_KNOWN_HOSTS` | output of `ssh-keyscan -t ed25519 SERVER` (pins the server, so the job fails if it is not the right machine) |

There is no path variable: the wrapper decides where the app lives.

## First deploy

Push to `main` (or run **Deploy** manually). Then open `APP_URL` and **create the first account straight
away**: with `ALLOW_SIGNUP=false` only the very first signup is accepted, and after that owners add members
under *Team*. Do this before sharing the URL.

## Inviting people

Signup stays closed; everyone gets in through a one-time invite link.

- **Someone outside your team** (their own separate team): sign in with an account listed in `ADMIN_EMAILS`, open
  **Invite a new team** in the sidebar, enter their email (and a team name if you like), and send them the link.
  They choose a password and become the owner of their own team.
- **Someone for your own team:** the team owner uses **Team → Invite someone**. A team has at most
  `MAX_TEAM_MEMBERS` seats including the owner, and pending invites count.

A link is shown once, works for one person, and expires after `INVITE_TTL_HOURS` (or sooner if you revoke it under
*Pending invites*). It is tied to the email you entered. The secret sits in the part of the URL after `#`, which browsers
do not send to the server, so it stays out of Caddy's access logs. New passwords must be at least 12 characters.

## Seeing and suspending teams

Admins (`ADMIN_EMAILS`) get **Teams** in the sidebar: every team on the server with its owners, seats, project count
and last activity, and a detail page with members, invites and API keys (the prefix only, never the key). You see
names, emails and counts, **never what a team wrote** (tickets, comments, the map).

**Suspend** cuts a whole team off and is reversible. You type the team's exact name to confirm, and optionally a reason
that only admins see. At once: every member is signed out, their sign-in is refused ("This team has been suspended"),
the team's API keys get a 403 on `/mcp` and `/api/v1`, and the team's invites stop working. Nothing is deleted.
**Restore** brings the team back as it was; people sign in again. You cannot suspend your own team. Suspensions are
logged on the server (`[admin] team suspended <id> by <user>`).

## Updating the compose file or scripts

Deploys change only the image. When `docker-compose.yml` or a `deploy/*.sh` script changes in the repo, copy it to
the server **before** pushing a change that depends on it (the destination must end in the app directory):

```bash
scp docker-compose.yml deploy/deploy.sh deploy/backup.sh deploy/restore.sh root@YOUR_VPS:/opt/apps/wheelhouse/
ssh root@YOUR_VPS 'chmod 755 /opt/apps/wheelhouse/*.sh'
```

Do not edit them on the server: the repo copy is the source of truth.

## Rolling back

- **Bad image, healthy database:** run **Deploy** manually and enter the commit SHA of the last good build (its
  image is still in GHCR).
- **Bad migration:** the pre-deploy dump is in `/opt/apps/wheelhouse/backups/pre-deploy-*.sql.gz` (last 10 kept).
  Stop the app (`cd /opt/apps/wheelhouse && docker compose stop app`), drop and recreate the empty `wheelhouse` database, restore with
  `deploy/restore.sh`, then deploy the old SHA.

## Backups

`deploy/backup.sh` dumps the database nightly and keeps 14 days locally. **A dump on the same disk is not a
backup**: set `RCLONE_REMOTE` (for example `b2:my-bucket/wheelhouse`, after `rclone config`) and it also copies
each dump off the server and prunes old ones there. Install it once:

```bash
sudo rclone config                     # only if using RCLONE_REMOTE (the files are root-owned, so root runs it)
sudo crontab -e
# 15 3 * * * cd /opt/apps/wheelhouse && ./backup.sh >> backups/backup.log 2>&1
```

`backup.sh` and `restore.sh` must be in `/opt/apps/wheelhouse` next to `.env` (see *Updating the compose file or scripts*).

**Prove a dump restores** (do this once now, and after any big change):

```bash
cd /opt/apps/wheelhouse && ./restore.sh backups/nightly-YYYYMMDD-HHMMSS.sql.gz
# restores into a scratch database "wheelhouse_restore_check" and prints row counts; compare with the live data
docker exec PG_CONTAINER psql -U PG_SUPERUSER -d postgres -c 'drop database wheelhouse_restore_check'
```

## GitHub App (optional)

With a GitHub App, GitHub tells Wheelhouse about every push to a connected repository's default branch (so people and
agents see each other's changes, and map nodes whose code changed are flagged, whether or not anyone runs the plugin),
links pull requests to the tickets they name, and shows CI results on those tickets. Without it everything else works;
repositories linked from a machine with the plugin or CLI keep reporting from there.

A self-hosted Wheelhouse needs **its own** GitHub App (ours cannot reach your server). Create it under your account or
organisation: *Settings → Developer settings → GitHub Apps → New GitHub App*.

| Setting | Value |
|---|---|
| Homepage URL | your `APP_URL` |
| Callback URL | `APP_URL/api/github/callback` |
| Setup URL | `APP_URL/api/github/callback`, with **Redirect on update** ticked |
| Request user authorization (OAuth) during installation | **ticked** (this is how Wheelhouse proves who is connecting an installation) |
| Webhook URL | `APP_URL/api/webhooks/github` |
| Webhook secret | a long random string (`openssl rand -hex 32`) |
| Repository permissions | Contents: **Read-only**, Pull requests: **Read-only**, Checks: **Read-only** (Metadata is added for you) |
| Subscribe to events | Push, Pull request, Check run |
| Where can it be installed | Only on this account (or any account, if other people will connect their own) |

Then put these in `/opt/apps/wheelhouse/.env` and redeploy (see `.env.example`):

| Variable | Where it comes from |
|---|---|
| `GITHUB_APP_ID` | the App's settings page |
| `GITHUB_APP_SLUG` | the last part of the App's public URL (`github.com/apps/<slug>`) |
| `GITHUB_APP_PRIVATE_KEY` | *Generate a private key* on the App's page; paste the `.pem`, or one line with literal `\n` |
| `GITHUB_WEBHOOK_SECRET` | the secret you chose |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | the App's *Client ID* and a generated client secret |

Leave all six empty to keep the integration off. Anyone who is a team **owner** then opens a project's
*Repositories* page, presses *Connect GitHub*, installs the App on the repositories they choose, and picks which of them
this project uses (a monorepo can be limited to a path). Push, pull request and CI events then arrive at the webhook.

What to know:

- **Signed and scoped.** Every delivery is checked against the webhook secret before anything is read, and a delivery can
  only reach a repository that a team connected through *its own* installation. An installation is tied to the team
  whose owner proved, through GitHub's sign-in, that they administer it; no one can claim someone else's.
- **Nothing but metadata.** Wheelhouse reads which files changed and their git hashes. It never stores file contents.
- **Pull requests move tickets with care.** Opened (not draft) moves a ticket to Review, closed without merging moves it
  back to In Progress, merged leaves it in Review for a person, a ticket in Done is never moved, and a ticket someone
  moved in the last ten minutes is left alone (the comment says so). Tickets are found by a ref such as `WH-12` in the
  pull request title or branch name.
- **Test it** from the App's *Advanced* tab: *Recent deliveries* shows each webhook's response and lets you redeliver.
  `200` with `"status":"ignored"` means the delivery was understood but is not about a connected repository.

## Live updates (server-sent events)

Open pages learn about changes over a long-lived connection, `GET /api/projects/<key>/stream` (and `/api/stream` for
the dashboard), instead of polling. It needs nothing beyond what is above, with two things to keep:

- **Caddy**: keep `flush_interval -1` in the site block, so events are passed on as they happen, not buffered.
- **Cloudflare** (or any proxy in front): streaming works as long as the response is not cached or buffered; the app sends
  `Cache-Control: no-cache, no-transform` and a heartbeat every 25 seconds, well inside the proxy's idle timeout.

The smoke test (see *Testing the package*) checks this through Caddy: it opens a stream, sees `ready` while the connection is
still open, makes a change, and sees the `change` event arrive on the same open stream.

The stream is fed by an in-process event bus, so it works on one app container, which is also the only supported
setup (migrations run at boot). It needs a long-running server like this one: serverless hosts that end a request after
a few seconds cannot hold the connection, and pages would fall back to slower polling. A person can have 12 streams open
at once (a project tab plus the dashboard each use one). If the stream cannot connect, pages poll every 10 seconds and
keep retrying it with backoff.

## Rate limits and the proxy

Sign-in is limited per client address (30 attempts per 15 minutes) and per email (8 per 15 minutes), sign-up per address (10 per
hour), invites per person, and the live streams to 12 per person. The client address is the **last** entry of `X-Forwarded-For`,
the one Caddy adds for the connection it received, so a client that sends its own header only puts entries in front of it
and cannot pick the address it is counted under. That holds only while Caddy is the proxy the internet reaches. If something
else (Cloudflare, a load balancer) sits in front of Caddy, every request arrives from that one address: configure Caddy's
`trusted_proxies` for it and keep the app reachable only through Caddy. The smoke test sends 35 sign-in attempts, each
claiming a different address, through the shipped Caddyfile and requires the limit to apply.

Sign-up is closed unless `ALLOW_SIGNUP=true` (only the very first account is accepted on a fresh database; see *First deploy*).

## Testing the package

Everything below needs only Docker and a checkout, and removes what it starts. The CI workflow runs all of it.

```bash
deploy/smoke-test.sh            # builds the image, starts Postgres + app + Caddy, then checks, through Caddy:
                                # the app shell and its assets (and their cache headers), the API, sign-up, a live stream,
                                # that forged X-Forwarded-For does not dodge the sign-in limit, backup.sh and restore.sh,
                                # and that the app stops within seconds on SIGTERM
deploy/contract-in-docker.sh    # the whole contract suite (/mcp, /api/v1, webhooks, GitHub connect, streams, /api/app)
                                # against the image on a real Postgres, behind Caddy, with a fake GitHub on the host
IMAGE=ghcr.io/shipstackhq/wheelhouse:<sha> deploy/smoke-test.sh    # the same, on a published image
```

The deploy workflow has a **dry run**: *Actions → Deploy → Run workflow* with *Dry run* ticked builds the image without
pushing it, never logs in to the registry or opens an SSH connection, and reports what it would deploy and whether the four
`DEPLOY_*` secrets are set.

## What the image is

A multi-stage `Dockerfile`: the React app is built (Vite), the API's production dependencies are installed
(`pnpm deploy`), and the final image holds those, the API and `@wheelhouse/core` as TypeScript source (run with `tsx`), and
the web build. It runs as a non-root user, `node` is PID 1 (so SIGTERM reaches the shutdown hook that closes the database; it
stops in about two seconds, longer only if requests are still open), `HEALTHCHECK` asks `/api/health`, and migrations run when
it boots. While the old Next.js app is still in the repository its dependencies are installed into the image as well and make it
larger than it needs to be; removing the Next app removes them.

## Limits to know about

- **One app container only.** Migrations run when the app boots, so two replicas starting together would race.
- **Shared Postgres.** A heavy query or a restart of the Postgres container affects the other apps on the server.
- **Rate limits are in memory** and reset when the container restarts.
