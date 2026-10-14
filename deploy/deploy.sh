#!/usr/bin/env bash
# Runs ON THE VPS (the deploy workflow copies it next to docker-compose.yml and .env).
#   IMAGE=ghcr.io/shipstackhq/wheelhouse:<sha> ./deploy.sh
# 1. dumps the wheelhouse database  2. swaps the app image  3. waits for /api/health
# 4. if the new image is not healthy, puts the previous image back and exits non-zero.
# The dump is the only way back from a bad migration: migrations are not rolled back.
set -euo pipefail
cd "$(dirname "$0")"

: "${IMAGE:?set IMAGE to the image to deploy}"
HEALTH_TRIES="${HEALTH_TRIES:-40}"   # x3s
KEEP_DUMPS="${KEEP_DUMPS:-10}"

get() { grep -E "^$1=" .env | tail -1 | cut -d= -f2- || true; }
set_env() {
  if grep -qE "^$1=" .env; then sed -i.bak -E "s|^$1=.*|$1=$2|" .env && rm -f .env.bak; else echo "$1=$2" >> .env; fi
}

PORT="$(get WHEELHOUSE_PORT)"; PORT="${PORT:-3000}"
PG_CONTAINER="$(get PG_CONTAINER)"
PG_DUMP_USER="$(get PG_DUMP_USER)"; PG_DUMP_USER="${PG_DUMP_USER:-postgres}"
PG_DB="$(get PG_DB)"; PG_DB="${PG_DB:-wheelhouse}"
PREVIOUS="$(get WHEELHOUSE_IMAGE)"

healthy() { curl -fsS -m 5 "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; }
wait_healthy() { for _ in $(seq 1 "$HEALTH_TRIES"); do healthy && return 0; sleep 3; done; return 1; }

[ -n "$PG_CONTAINER" ] || { echo "PG_CONTAINER is not set in .env (needed for the pre-deploy dump)"; exit 1; }

echo "==> dumping $PG_DB from $PG_CONTAINER"
mkdir -p backups
DUMP="backups/pre-deploy-$(date +%Y%m%d-%H%M%S).sql.gz"
docker exec "$PG_CONTAINER" pg_dump -U "$PG_DUMP_USER" -d "$PG_DB" --no-owner | gzip > "$DUMP"
[ -s "$DUMP" ] || { echo "dump is empty, aborting"; rm -f "$DUMP"; exit 1; }
ls -1t backups/pre-deploy-*.sql.gz | tail -n +"$((KEEP_DUMPS + 1))" | xargs -r rm -f --

echo "==> deploying $IMAGE (previous: ${PREVIOUS:-none})"
set_env WHEELHOUSE_IMAGE "$IMAGE"
[ -n "${SKIP_PULL:-}" ] || docker compose pull app
docker compose up -d --no-build --remove-orphans

if wait_healthy; then
  echo "==> healthy: $IMAGE"
  docker image prune -f >/dev/null 2>&1 || true
  exit 0
fi

echo "==> NOT healthy after $((HEALTH_TRIES * 3))s; last logs:"
docker compose logs --tail 40 app || true
if [ -n "$PREVIOUS" ] && [ "$PREVIOUS" != "$IMAGE" ]; then
  echo "==> rolling back to $PREVIOUS (database is NOT rolled back; dump: $DUMP)"
  set_env WHEELHOUSE_IMAGE "$PREVIOUS"
  docker compose up -d --no-build
  wait_healthy && echo "==> rolled back and healthy" || echo "==> rollback is not healthy either, check the host"
fi
exit 1
