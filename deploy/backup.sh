#!/usr/bin/env bash
# Nightly dump of the wheelhouse database, run ON THE VPS from cron (see docs/deploy.md):
#   15 3 * * * cd /opt/wheelhouse && ./backup.sh >> backups/backup.log 2>&1
# Keeps KEEP_DAYS of dumps locally. If RCLONE_REMOTE is set (e.g. b2:my-bucket/wheelhouse) each dump is
# also copied there and remote dumps older than KEEP_DAYS are pruned. A dump that only lives on the
# same disk is not a backup: set RCLONE_REMOTE.
set -euo pipefail
cd "$(dirname "$0")"

get() { grep -E "^$1=" .env | tail -1 | cut -d= -f2- || true; }
PG_CONTAINER="$(get PG_CONTAINER)"
PG_DUMP_USER="$(get PG_DUMP_USER)"; PG_DUMP_USER="${PG_DUMP_USER:-postgres}"
PG_DB="$(get PG_DB)"; PG_DB="${PG_DB:-wheelhouse}"
RCLONE_REMOTE="$(get RCLONE_REMOTE)"
KEEP_DAYS="${KEEP_DAYS:-14}"

[ -n "$PG_CONTAINER" ] || { echo "PG_CONTAINER is not set in .env"; exit 1; }
mkdir -p backups
OUT="backups/nightly-$(date +%Y%m%d-%H%M%S).sql.gz"
docker exec "$PG_CONTAINER" pg_dump -U "$PG_DUMP_USER" -d "$PG_DB" --no-owner | gzip > "$OUT"
# A truncated dump is worse than none: it must be a valid gzip with a non-trivial body.
gzip -t "$OUT" && [ "$(stat -c%s "$OUT" 2>/dev/null || stat -f%z "$OUT")" -gt 200 ] || { echo "bad dump $OUT"; rm -f "$OUT"; exit 1; }
echo "$(date '+%Y-%m-%dT%H:%M:%S%z') wrote $OUT"

find backups -name 'nightly-*.sql.gz' -mtime +"$KEEP_DAYS" -delete

if [ -n "$RCLONE_REMOTE" ]; then
  rclone copyto "$OUT" "$RCLONE_REMOTE/$(basename "$OUT")"
  rclone delete --min-age "${KEEP_DAYS}d" "$RCLONE_REMOTE" --include 'nightly-*.sql.gz'
  echo "$(date '+%Y-%m-%dT%H:%M:%S%z') uploaded to $RCLONE_REMOTE"
else
  echo "WARNING: RCLONE_REMOTE is not set, this dump exists only on this server" >&2
fi
