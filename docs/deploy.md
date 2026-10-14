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
SHA, copies `docker-compose.yml` and the `deploy/*.sh` scripts to the server over SSH, and runs the script. The
script dumps the database, swaps the image, waits for `/api/health`, and **puts the previous image back if the
new one is not healthy**. It cannot undo a migration, which is why it dumps first.

## One-time server setup

Run on the VPS. Names in `CAPS` are yours to choose.

**1. Database and role** (replace the password; `PG_CONTAINER` is your Postgres container's name):

```bash
docker exec -it PG_CONTAINER psql -U postgres -c "create role wheelhouse login password 'STRONG_PASSWORD'"
docker exec -it PG_CONTAINER psql -U postgres -c "create database wheelhouse owner wheelhouse"
docker inspect PG_CONTAINER --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}}{{"\n"}}{{end}}'   # the network name
```

The role owns only its own database, so it cannot read the other apps' data.

**2. Deploy user and directory**

```bash
sudo adduser --disabled-password deploy && sudo usermod -aG docker deploy   # docker group = root-equivalent, use a dedicated user
sudo mkdir -p /opt/wheelhouse && sudo chown deploy: /opt/wheelhouse
sudo -u deploy mkdir -p ~deploy/.ssh && echo 'ssh-ed25519 AAAA... github-deploy' | sudo -u deploy tee -a ~deploy/.ssh/authorized_keys
```

Create the key pair on your machine (`ssh-keygen -t ed25519 -f deploy_key -C github-deploy`) and put the public
half above; the private half goes into GitHub (step below).

**3. `/opt/wheelhouse/.env`** (copy `.env.example` and fill it in):

| Variable | Value |
|---|---|
| `APP_URL` | `https://wheelhouse.example.com` |
| `DATABASE_URL` | `postgres://wheelhouse:STRONG_PASSWORD@PG_CONTAINER:5432/wheelhouse` |
| `POSTGRES_NETWORK` | the network from step 1 |
| `WHEELHOUSE_PORT` | `3000` (or any free port; Caddy points here) |
| `PG_CONTAINER`, `PG_DB`, `PG_DUMP_USER` | container name, `wheelhouse`, `postgres` (used by the dump) |
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
| Secret | `DEPLOY_USER` | `deploy` |
| Secret | `DEPLOY_SSH_KEY` | the private key from step 2 |
| Secret | `DEPLOY_KNOWN_HOSTS` | output of `ssh-keyscan -t ed25519 SERVER` (pins the server, so the job fails if it is not the right machine) |
| Variable | `DEPLOY_PATH` | `/opt/wheelhouse` |

The server pulls with the workflow's own token, which exists only for that run, so no registry password is
stored on the server.

## First deploy

Push to `main` (or run **Deploy** manually). Then open `APP_URL` and **create the first account straight
away**: with `ALLOW_SIGNUP=false` only the very first signup is accepted, and after that owners add members
under *Team*. Do this before sharing the URL.

## Rolling back

- **Bad image, healthy database:** run **Deploy** manually and enter the commit SHA of the last good build (its
  image is still in GHCR).
- **Bad migration:** the pre-deploy dump is in `/opt/wheelhouse/backups/pre-deploy-*.sql.gz` (last 10 kept).
  Stop the app (`docker compose stop app`), drop and recreate the empty `wheelhouse` database, restore with
  `deploy/restore.sh`, then deploy the old SHA.

## Backups

`deploy/backup.sh` dumps the database nightly and keeps 14 days locally. **A dump on the same disk is not a
backup**: set `RCLONE_REMOTE` (for example `b2:my-bucket/wheelhouse`, after `rclone config`) and it also copies
each dump off the server and prunes old ones there. Install it once:

```bash
sudo -u deploy rclone config            # only if using RCLONE_REMOTE
sudo -u deploy crontab -e
# 15 3 * * * cd /opt/wheelhouse && ./backup.sh >> backups/backup.log 2>&1
```

The deploy workflow copies `backup.sh` and `restore.sh` to `/opt/wheelhouse` along with `deploy.sh`.

**Prove a dump restores** (do this once now, and after any big change):

```bash
cd /opt/wheelhouse && ./restore.sh backups/nightly-YYYYMMDD-HHMMSS.sql.gz
# restores into a scratch database "wheelhouse_restore_check" and prints row counts; compare with the live data
docker exec PG_CONTAINER psql -U postgres -c 'drop database wheelhouse_restore_check'
```

## Limits to know about

- **One app container only.** Migrations run when the app boots, so two replicas starting together would race.
- **Shared Postgres.** A heavy query or a restart of the Postgres container affects the other apps on the server.
- **Rate limits are in memory** and reset when the container restarts.
