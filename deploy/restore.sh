#!/usr/bin/env bash
# Restore a dump into a database. Run ON THE VPS.
#   ./restore.sh backups/nightly-....sql.gz                  # into a scratch database; proves the dump restores
#   ./restore.sh backups/nightly-....sql.gz wheelhouse       # into the live database (see below)
# Restoring into the live database: stop the app first (docker compose stop app), drop and recreate the
# empty database yourself, then run this, then start the app. The script refuses to restore into a
# database that already has tables.
# Objects are created by RESTORE_USER (default: the app role "wheelhouse"), so the app owns them.
set -euo pipefail
cd "$(dirname "$0")"

DUMP="${1:?usage: restore.sh <dump.sql.gz> [target_db]}"
TARGET="${2:-wheelhouse_restore_check}"
get() { grep -E "^$1=" .env | tail -1 | cut -d= -f2- || true; }
PG_CONTAINER="$(get PG_CONTAINER)"
ADMIN="$(get PG_DUMP_USER)"; ADMIN="${ADMIN:-postgres}"
RESTORE_USER="${RESTORE_USER:-wheelhouse}"
[ -n "$PG_CONTAINER" ] || { echo "PG_CONTAINER is not set in .env"; exit 1; }
[ -f "$DUMP" ] && gzip -t "$DUMP"

psql_admin() { docker exec -i "$PG_CONTAINER" psql -U "$ADMIN" -v ON_ERROR_STOP=1 "$@"; }
if ! psql_admin -d postgres -tAc "select 1 from pg_database where datname='$TARGET'" | grep -q 1; then
  psql_admin -d postgres -c "create database \"$TARGET\" owner \"$RESTORE_USER\""
fi
TABLES="$(psql_admin -d "$TARGET" -tAc "select count(*) from information_schema.tables where table_schema='public'")"
[ "$TABLES" = "0" ] || { echo "$TARGET already has $TABLES tables; refusing to restore over it"; exit 1; }

gunzip -c "$DUMP" | docker exec -i "$PG_CONTAINER" psql -U "$RESTORE_USER" -d "$TARGET" -v ON_ERROR_STOP=1 -q >/dev/null
echo "restored $DUMP into $TARGET. Row counts:"
psql_admin -d "$TARGET" -tAc "select 'users '||count(*) from users union all select 'tickets '||count(*) from tickets union all select 'events '||count(*) from events union all select 'migrations '||count(*) from drizzle.__drizzle_migrations"
