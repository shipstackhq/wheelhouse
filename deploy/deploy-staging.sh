#!/usr/bin/env bash
# Runs ON THE STAGING SERVER, by hand, next to deploy.sh, docker-compose.yml and .env (docs: "Staging deploys: plan and runbook").
#   ./deploy-staging.sh              deploy the image CI published as :staging
#   ./deploy-staging.sh --check      say what would be deployed and which migrations would run; change nothing
#   ./deploy-staging.sh --to <tag>   deploy another published tag instead (a commit SHA, to roll back)
# Refuses when that image is already running, shows what changes and asks, then hands over to deploy.sh: a pre-deploy dump,
# the image swap, the health gate and an automatic rollback of the container. Migrations run when the app starts, all pending
# ones in one transaction, so a failed one leaves the schema as it was and the health gate puts the previous image back.
set -euo pipefail
cd "$(dirname "$0")"

REPO="ghcr.io/shipstackhq/wheelhouse"
TAG="staging"
CHECK=""
while [ $# -gt 0 ]; do
  case "$1" in
    --check) CHECK=1 ;;
    --to) TAG="${2:?--to needs a tag}"; shift ;;
    *) echo "usage: $0 [--check] [--to <tag>]" >&2; exit 2 ;;
  esac
  shift
done

die() { echo "!! $*" >&2; exit 1; }
get() { grep -E "^$1=" .env | tail -1 | cut -d= -f2- || true; }
# The commit an image was built from, from the label CI sets; "unknown" for images built by hand.
rev() { docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$1" 2>/dev/null | grep -vx '<no value>' || echo unknown; }

exec 9>/tmp/wheelhouse-staging-deploy.lock
flock -n 9 || die "another deploy is running"
command -v jq >/dev/null || die "jq is not installed"
free_gb=$(( $(df -Pk . | awk 'NR==2 {print $4}') / 1024 / 1024 ))
[ "$free_gb" -ge 2 ] || die "only ${free_gb} GB free on disk"

echo "==> pulling $REPO:$TAG"
docker pull -q "$REPO:$TAG" >/dev/null || die "pull failed (is this server logged in? docker login ghcr.io)"
new_id="$(docker image inspect -f '{{.Id}}' "$REPO:$TAG")"
digest="$(docker image inspect -f '{{index .RepoDigests 0}}' "$REPO:$TAG")"
running="$(docker compose ps -q app)"
old_id="$([ -n "$running" ] && docker inspect -f '{{.Image}}' "$running" || echo none)"
[ "$new_id" != "$old_id" ] || die "$REPO:$TAG is already running; nothing to deploy"

from="$(get WHEELHOUSE_IMAGE)"
echo "    from: ${from:-none} ($([ "$old_id" = none ] && echo none || rev "$old_id"))"
echo "    to:   $digest ($(rev "$new_id"))"

# What Drizzle will apply on start: every migration newer than the newest one recorded in the database.
pg="$(get PG_CONTAINER)"; pg_user="$(get PG_DUMP_USER)"; pg_db="$(get PG_DB)"
if last="$(docker exec "$pg" psql -U "${pg_user:-postgres}" -d "${pg_db:-wheelhouse}" -tAc 'select coalesce(max(created_at), 0) from drizzle.__drizzle_migrations' 2>/dev/null)"; then
  pending="$(docker run --rm --entrypoint cat "$new_id" /app/drizzle/meta/_journal.json | jq -r --argjson last "$last" '.entries[] | select(.when > $last) | .tag' | paste -sd' ' -)"
  echo "    migrations that will run: ${pending:-none}"
else
  echo "    migrations: could not read the applied ones from $pg"
fi

if [ -n "$CHECK" ]; then echo "==> --check: nothing was changed"; exit 0; fi
read -r -p "Deploy it? [y/N] " answer
[ "$answer" = y ] || [ "$answer" = Y ] || die "not deployed"

if IMAGE="$digest" SKIP_PULL=1 ./deploy.sh; then result=deployed; else result=failed; fi
echo "$(date -u +%FT%TZ) $result $(rev "$new_id") $digest (was ${from:-none})" >> deploys.log
[ "$result" = deployed ]
