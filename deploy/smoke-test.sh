#!/usr/bin/env bash
# End-to-end check of the packaged app on a machine with Docker, from a clean state (WH-99). Builds the image, starts the
# standalone stack (Postgres, the app, Caddy), and checks through Caddy, the way a browser or the plugin would reach it:
#   the React app and its assets, the API, sign-up, a live stream that delivers an event WHILE it is still open (so nothing buffers
#   it), then the backup and restore scripts against the stack's Postgres. Everything is removed at the end.
#   deploy/smoke-test.sh                 # builds wheelhouse:smoke from this checkout
#   IMAGE=ghcr.io/shipstackhq/wheelhouse:<sha> deploy/smoke-test.sh   # tests a published image instead
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${SMOKE_PORT:-18080}"
BASE="http://127.0.0.1:$PORT"
export WHEELHOUSE_IMAGE="${IMAGE:-wheelhouse:smoke}"
export POSTGRES_PASSWORD="smoke-$(date +%s)" APP_URL="$BASE" SITE_ADDRESS=":80" HTTP_PORT="$PORT" HTTPS_PORT="$((PORT + 363))"
export ALLOW_SIGNUP=false
C=(docker compose -p whsmoke -f docker-compose.standalone.yml)
WORK="$(mktemp -d)"
fail=0
ok() { echo "  ok   $*"; }
bad() { echo "  FAIL $*"; fail=1; }
check() { local what="$1"; shift; if "$@" >/dev/null 2>&1; then ok "$what"; else bad "$what"; fi; }
cleanup() { "${C[@]}" down -v --remove-orphans >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT

echo "==> starting the stack ($WHEELHOUSE_IMAGE)"
if [ -z "${IMAGE:-}" ]; then "${C[@]}" build app; fi
"${C[@]}" up -d
for _ in $(seq 1 60); do curl -fsS -m 3 "$BASE/api/health" >/dev/null 2>&1 && break; sleep 2; done
curl -fsS "$BASE/api/health" >/dev/null || { "${C[@]}" logs --tail 40 app; echo "never became healthy"; exit 1; }
ok "health through Caddy: $(curl -fsS "$BASE/api/health")"
check "the container's own health check passes" bash -c "for _ in \$(seq 1 20); do [ \"\$(docker inspect -f '{{.State.Health.Status}}' \$(docker compose -p whsmoke -f docker-compose.standalone.yml ps -q app))\" = healthy ] && exit 0; sleep 3; done; exit 1"

echo "==> the React app"
HTML="$(curl -fsS "$BASE/p/WH/map")"
check "any page address returns the app shell" grep -q '<div id="root">' <<<"$HTML"
ASSET="$(grep -o '/assets/[^"]*\.js' <<<"$HTML" | head -1)"
check "its script is served with a year's cache ($ASSET)" bash -c "curl -fsSI '$BASE$ASSET' | tr -d '\r' | grep -qi 'cache-control: public, max-age=31536000, immutable'"
check "the shell is never cached" bash -c "curl -fsSI '$BASE/login' | tr -d '\r' | grep -qi 'cache-control: no-cache'"
check "a missing script is a 404, not HTML" bash -c "[ \"\$(curl -s -o /dev/null -w '%{http_code}' '$BASE/assets/nope-123.js')\" = 404 ]"
check "the service worker and manifest are served" bash -c "curl -fsS '$BASE/sw.js' >/dev/null && curl -fsS '$BASE/manifest.webmanifest' >/dev/null"

echo "==> the API, through Caddy"
check "signed out is a 401 in the JSON envelope" bash -c "curl -s '$BASE/api/app/me' | grep -q unauthorized"
check "the MCP endpoint answers (401 without a key)" bash -c "[ \"\$(curl -s -o /dev/null -w '%{http_code}' -X POST '$BASE/mcp')\" = 401 ]"
check "the webhook refuses an unsigned delivery (503 with no GitHub App)" bash -c "[ \"\$(curl -s -o /dev/null -w '%{http_code}' -X POST '$BASE/api/webhooks/github')\" = 503 ]"

echo "==> sign up, then a live stream through Caddy"
SIGNUP="$(curl -fsS -c "$WORK/jar" -H "Origin: $BASE" -H "X-CSRF-Token: anonymous" -H 'content-type: application/json' \
  -d '{"name":"Smoke","email":"smoke@example.test","password":"a-long-enough-password","team":"Smoke team"}' "$BASE/api/app/auth/signup")"
CSRF="$(sed -E 's/.*"csrfToken":"([^"]+)".*/\1/' <<<"$SIGNUP")"
post() { curl -fsS -b "$WORK/jar" -H "Origin: $BASE" -H "X-CSRF-Token: $CSRF" -H 'content-type: application/json' -d "$2" "$BASE$1"; }
post /api/app/projects '{"name":"Smoke","key":"SMK"}' >/dev/null
ok "signed up and created a project"
curl -sN -m 12 -b "$WORK/jar" "$BASE/api/projects/SMK/stream" > "$WORK/stream" 2>/dev/null &
SSE=$!
sleep 3
check "the stream said 'ready' while still open (not held back by the proxy)" grep -q 'event: ready' "$WORK/stream"
post /api/app/projects/SMK/tickets '{"title":"live"}' >/dev/null
sleep 3
check "a change arrived on the open stream within seconds" grep -q 'event: change' "$WORK/stream"
check "the stream is not compressed" bash -c "! grep -qi 'content-encoding' <(curl -sNI -m 3 -H 'Accept-Encoding: gzip' -b '$WORK/jar' '$BASE/api/projects/SMK/stream' 2>/dev/null | head -20)"
kill "$SSE" 2>/dev/null || true; wait "$SSE" 2>/dev/null || true

echo "==> sign-in rate limiting cannot be dodged by a forged X-Forwarded-For"
# The limit is per client address, and the address is the LAST entry of X-Forwarded-For: the one Caddy adds. A client that sends
# its own header only adds entries in front of it. 35 attempts (the limit is 30 per 15 minutes), each claiming to be someone else:
LIMITED=0
for i in $(seq 1 35); do
  code="$(curl -s -o /dev/null -w '%{http_code}' -H "Origin: $BASE" -H "X-CSRF-Token: anonymous" -H "X-Forwarded-For: 10.9.$((i / 250)).$((i % 250 + 1))" \
    -H 'content-type: application/json' -d "{\"email\":\"nobody$i@example.test\",\"password\":\"wrong-password-$i\"}" "$BASE/api/app/auth/login")"
  [ "$code" = 429 ] && LIMITED=$((LIMITED + 1))
done
[ "$LIMITED" -gt 0 ] && ok "the limit applied ($LIMITED of 35 attempts refused with 429) although each forged a different address" || bad "35 attempts with forged addresses were never limited"

echo "==> backup and restore, against this stack's Postgres"
PG="$("${C[@]}" ps -q postgres)"
PGNAME="$(docker inspect -f '{{.Name}}' "$PG" | sed 's|^/||')"
mkdir -p "$WORK/ops/backups"
cp deploy/backup.sh deploy/restore.sh "$WORK/ops/"
printf 'PG_CONTAINER=%s\nPG_DUMP_USER=wheelhouse\nPG_DB=wheelhouse\n' "$PGNAME" > "$WORK/ops/.env"
(cd "$WORK/ops" && ./backup.sh >/dev/null 2>"$WORK/backup.err") && ok "backup.sh wrote a valid dump" || { bad "backup.sh"; cat "$WORK/backup.err"; }
DUMP="$(ls -1 "$WORK"/ops/backups/nightly-*.sql.gz | head -1)"
RESULT="$(cd "$WORK/ops" && ./restore.sh "$DUMP" 2>&1)" && ok "restore.sh restored it into a scratch database" || { bad "restore.sh"; echo "$RESULT"; }
EXPECTED="$(node -p "require('./packages/core/drizzle/meta/_journal.json').entries.length")"
check "the restored database has the user, the ticket and all $EXPECTED migrations" bash -c "grep -q '^users 1' <<<'$RESULT' && grep -q '^tickets 1' <<<'$RESULT' && grep -q '^migrations $EXPECTED' <<<'$RESULT'"
check "restore refuses to restore over a database that has tables" bash -c "cd '$WORK/ops' && ! ./restore.sh '$DUMP' >/dev/null 2>&1"

echo "==> shutdown"
START=$(date +%s)
"${C[@]}" stop app >/dev/null 2>&1
ELAPSED=$(( $(date +%s) - START ))
[ "$ELAPSED" -le 5 ] && ok "the app stops within 5 seconds, on SIGTERM (${ELAPSED}s)" || bad "the app took ${ELAPSED}s to stop"
check "it exited cleanly (code 0)" bash -c "[ \"\$(docker inspect -f '{{.State.ExitCode}}' \$(docker compose -p whsmoke -f docker-compose.standalone.yml ps -aq app))\" = 0 ]"

[ "$fail" = 0 ] && echo "==> all checks passed" || { echo "==> FAILED"; exit 1; }
