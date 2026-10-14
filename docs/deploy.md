# Deploying Wheelhouse on a VPS

Wheelhouse ships as one container (`ghcr.io/shipstackhq/wheelhouse`). It uses a Postgres and a Caddy that
already run on the server, so there is no database or proxy container in `docker-compose.yml`.

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
| `ALLOW_SIGNUP` | `false` |
| `RCLONE_REMOTE` | optional, off-box backup target, see Backups |

`chmod 600 .env`. `WHEELHOUSE_IMAGE` is written by the deploy script.

**4. Caddy**: add a site block to the existing Caddyfile and reload (`sudo systemctl reload caddy`):

```
wheelhouse.example.com {
    reverse_proxy 127.0.0.1:3000 {
        flush_interval -1     # stream responses straight through (needed once SSE live updates land, WH-1)
    }
}
```

Caddy sets `X-Forwarded-For` itself; the app's rate limits use it, so do not turn that off. If Caddy runs in
Docker instead of on the host, join the app to Caddy's network and use `reverse_proxy wheelhouse-app:3000`.

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

## Limits to know about

- **One app container only.** Migrations run when the app boots, so two replicas starting together would race.
- **Shared Postgres.** A heavy query or a restart of the Postgres container affects the other apps on the server.
- **Rate limits are in memory** and reset when the container restarts.
