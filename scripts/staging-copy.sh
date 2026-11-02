#!/usr/bin/env bash
# A copy of staging's database on this machine, for UI work (docs: "Staging deploys: plan and runbook").
#   pnpm db:staging-copy     take a fresh dump of staging over SSH and restore it into the local database wheelhouse_staging_copy
#   pnpm dev:staging-copy    run the API on that copy, with GitHub switched off
# The copy is replaced as a whole, so a failed restore leaves no half-copied database. Staging is only read. Local and staging
# share one GitHub App, so on the copy the API runs without it: staging's installations are in the data, and a local server
# must never act on them. The copy is not scrubbed: every account on staging today is the owner's (7 of them). It warns when that
# number changes, so a new person's data is never copied without someone looking first.
set -euo pipefail
cd "$(dirname "$0")/.."

HOST="${STAGING_SSH:-atharvamalji@shipstack-staging}"
APP_DIR=/opt/apps/wheelhouse
PG="${LOCAL_PG_CONTAINER:-postgres}"
DB=wheelhouse_staging_copy
EXPECTED_USERS=7 # every one the owner's (2026-11-02); change it only after checking who is new

die() { echo "!! $*" >&2; exit 1; }
local_url="$(grep -E '^DATABASE_URL=' .env.local 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"')" || true
[ -n "$local_url" ] || die "no DATABASE_URL in .env.local"
[[ "$local_url" =~ ^postgres(ql)?://([^:@/]+)(:[^@]*)?@(127\.0\.0\.1|localhost)(:[0-9]+)?/ ]] || die "the local DATABASE_URL is not a Postgres on this machine; refusing"
role="${BASH_REMATCH[2]}"
copy_url="$(sed -E "s#^(postgres(ql)?://[^/]+/)[^?]*#\1$DB#" <<<"$local_url")"

if [ "${1:-}" = dev ]; then
  echo "==> API on $DB, GitHub off"
  exec env DATABASE_URL="$copy_url" GITHUB_APP_ID= pnpm --filter @wheelhouse/api dev
fi
[ -z "${1:-}" ] || die "usage: $0 [dev]"

docker inspect "$PG" >/dev/null 2>&1 || die "the local Postgres container \"$PG\" is not running"
psql_as() { docker exec -i "$PG" psql -U "$1" -v ON_ERROR_STOP=1 -q "${@:2}"; }

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
echo "==> dumping staging ($HOST)"
# Only the three names pg_dump needs are read from the server's .env (with deploy.sh's defaults); nothing else leaves it.
ssh -o BatchMode=yes "$HOST" bash -s > "$work/staging.sql.gz" <<REMOTE
set -euo pipefail
cd $APP_DIR
get() { grep -E "^\$1=" .env | tail -1 | cut -d= -f2- || true; }
user="\$(get PG_DUMP_USER)"; db="\$(get PG_DB)"
docker exec "\$(get PG_CONTAINER)" pg_dump -U "\${user:-postgres}" -d "\${db:-wheelhouse}" --no-owner --no-privileges | gzip
REMOTE
gzip -t "$work/staging.sql.gz" && [ "$(wc -c < "$work/staging.sql.gz")" -gt 1000 ] || die "the dump is empty or broken; the local copy was not touched"

echo "==> restoring into $DB (owner $role)"
psql_as postgres -d postgres -c "DROP DATABASE IF EXISTS $DB WITH (FORCE)" -c "CREATE DATABASE $DB OWNER \"$role\""
gunzip -c "$work/staging.sql.gz" | psql_as "$role" -d "$DB" --single-transaction >/dev/null

users="$(psql_as "$role" -d "$DB" -tAc 'select count(*) from users')"
migrations="$(psql_as "$role" -d "$DB" -tAc 'select count(*) from drizzle.__drizzle_migrations')"
echo "==> done: $users user(s), $migrations migrations applied on staging"
[ "$users" = "$EXPECTED_USERS" ] || echo "!! staging now has $users accounts, not $EXPECTED_USERS. Check who is new before using this copy; if it is not you, drop the copy and add a scrub."
echo "    run the API on it: pnpm dev:staging-copy   (stop the usual API first; the web app is unchanged)"
