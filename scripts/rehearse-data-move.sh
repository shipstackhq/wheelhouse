#!/usr/bin/env bash
# One full rehearsal of the data move (WH-100) on a COPY of Wheelhouse's data, timed, with every check the cutover needs.
#   scripts/rehearse-data-move.sh <PGlite directory of the source> [rehearsal name]
# The source directory is only copied: stop the app that owns it first (SIGTERM, so it flushes) or point this at a copy.
# Needs Docker (a throwaway Postgres 18) and, for the continuity checks, the same .env.local the app runs with. Writes
# everything under .work/rehearsal-<name>/, prints one line per step with its time, and exits non-zero if anything disagreed.
set -uo pipefail
cd "$(dirname "$0")/.."
SOURCE="${1:?usage: rehearse-data-move.sh <PGlite directory> [name]}"
NAME="${2:-$(date +%Y%m%d-%H%M%S)}"
W="$PWD/.work/rehearsal-$NAME"
rm -rf "$W"; mkdir -p "$W"
LOG="$W/rehearsal.log"
exec > >(tee "$LOG") 2>&1

PORT_APP="${REHEARSAL_PORT:-4710}"
PORT_PG="${REHEARSAL_PG_PORT:-55477}"
PORT_FAKE="${REHEARSAL_FAKE_PORT:-4711}"
fail=0
T0=$(date +%s)
step() { STEP_NAME="$1"; STEP_T=$(date +%s); echo; echo "==> $1"; }
done_step() { echo "    ($(( $(date +%s) - STEP_T ))s)"; }
ok() { echo "  ok   $*"; }
bad() { echo "  FAIL $*"; fail=1; }
APP_PID=""; PG=""
stop_app() { [ -n "$APP_PID" ] && { kill "$APP_PID" 2>/dev/null; wait "$APP_PID" 2>/dev/null; APP_PID=""; }; lsof -ti :"$PORT_APP" -sTCP:LISTEN | xargs -r kill 2>/dev/null; sleep 1; }
cleanup() { stop_app; [ -n "$PG" ] && docker rm -f "$PG" >/dev/null 2>&1; lsof -ti :"$PORT_FAKE" -sTCP:LISTEN | xargs -r kill 2>/dev/null; true; }
trap cleanup EXIT
db() { pnpm --silent exec tsx packages/core/src/tools/db-cli.ts "$@"; }

echo "rehearsal $NAME: source $SOURCE ($(du -sh "$SOURCE" | cut -f1))"
echo "tool version: $(git rev-parse --short HEAD)$(git diff --quiet && echo '' || echo '+uncommitted')"

step "0. bring a COPY of the source to this code's migrations (the export refuses to cross migrations)"
if [[ "$SOURCE" != postgres* ]]; then
  cp -R "$SOURCE" "$W/source-migrated" && SOURCE="$W/source-migrated"
  db migrate --to "$SOURCE" || { bad "migrate the source copy"; exit 1; }
fi
done_step

step "1. export the source (it is copied first, never opened in place)"
db export --from "$SOURCE" --out "$W/export" || { bad "export"; exit 1; }
du -sh "$W/export" | sed 's/^/    export size: /'
done_step

step "2. import into a fresh PGlite directory"
db import --in "$W/export" --to "$W/pglite" | head -3 || bad "import (PGlite)"
done_step

step "3. verify the PGlite copy: against the export, and against the source directly"
db verify --in "$W/export" --to "$W/pglite" && ok "matches the export" || bad "verify against the export"
db verify --from "$SOURCE" --to "$W/pglite" | tail -1 && ok "matches the source" || bad "verify against the source"
done_step

step "4. the same into a real Postgres 18 (the production database), and back"
PG="whrehearsal-$$"
docker run -d --name "$PG" -p "127.0.0.1:$PORT_PG:5432" -e POSTGRES_PASSWORD=pw -e POSTGRES_DB=wheelhouse postgres:18 >/dev/null
for _ in $(seq 1 40); do docker exec "$PG" pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done; sleep 2
PGURL="postgres://postgres:pw@127.0.0.1:$PORT_PG/wheelhouse"
db import --in "$W/export" --to "$PGURL" | head -1 || bad "import (Postgres)"
db verify --in "$W/export" --to "$PGURL" | tail -1 && ok "Postgres matches the export" || bad "verify Postgres"
db export --from "$PGURL" --out "$W/export-from-pg" | tail -1
db import --in "$W/export-from-pg" --to "$W/pglite-from-pg" | head -1
db verify --in "$W/export" --to "$W/pglite-from-pg" | tail -1 && ok "PGlite → Postgres → PGlite is identical to the source" || bad "round trip"
done_step

# ───────── the new app on the copy ─────────
start_app() { # <data dir> <env file or empty>
  stop_app
  ( set -a; [ -f .env.local ] && . ./.env.local; [ -n "${2:-}" ] && . "$2"; set +a; PGLITE_DIR="$1" DATABASE_URL="" PORT="$PORT_APP" HOST=127.0.0.1 ALLOW_SIGNUP=false exec pnpm --silent --filter @wheelhouse/api exec tsx src/main.ts ) > "$W/app.log" 2>&1 &
  APP_PID=$!
  for _ in $(seq 1 60); do curl -fsS -m 2 "http://127.0.0.1:$PORT_APP/api/health" >/dev/null 2>&1 && return 0; sleep 1; done
  tail -5 "$W/app.log"; return 1
}
BASE="http://127.0.0.1:$PORT_APP"

step "5. continuity: the new app on the copy, with the same environment as the old one"
CRED_URL="$(node -e 'const c=JSON.parse(require("fs").readFileSync(process.env.HOME+"/.config/wheelhouse/credentials.json","utf8")); console.log(Object.keys(c)[0])')"
cp -R "$W/pglite" "$W/pglite-app"
# The map is brought up to date with the new layout on the copy BEFORE the app starts, exactly as the runbook does it on the cutover day.
pnpm --silent map:reanchor --db "$W/pglite-app" --from pre-migration --to HEAD --rules docs/reanchor-rules.json --apply > "$W/reanchor.log" 2>&1 && ok "map:reanchor --apply: $(grep -c '^node\|^doc' "$W/reanchor.log") node(s) and doc(s) re-anchored, every anchor resolved" || { bad "map:reanchor left anchors unresolved"; tail -6 "$W/reanchor.log"; }
pnpm --silent map:reanchor --db "$W/pglite-app" --from pre-migration --to HEAD --rules docs/reanchor-rules.json > "$W/reanchor2.log" 2>&1 && ! grep -q '^node\|^doc' "$W/reanchor2.log" && ok "a second map:reanchor plans nothing" || bad "map:reanchor is not idempotent"
pnpm --silent map:after-migration --db "$W/pglite-app" > "$W/after-migration.log" 2>&1 && ok "map:after-migration: $(grep -c '^  done' "$W/after-migration.log") change(s) to what the map says" || { bad "map:after-migration failed"; tail -5 "$W/after-migration.log"; }
pnpm --silent map:after-migration --db "$W/pglite-app" 2>&1 | grep -q "nothing to change" && ok "and a second run changes nothing" || bad "map:after-migration is not idempotent"
db verify --to "$W/pglite-app" --integrity-only | tail -1 | grep -q "integrity holds" && ok "integrity still holds after the map was updated" || bad "integrity after the map update"
cp -R "$W/pglite-app" "$W/pglite-mapped"
# What the data says before the app touches it: the real key's cursor, the newest event, a connected repository, an open ticket.
FACTS="$(node scripts/rehearsal/facts.mjs "$W/pglite-app")"
echo "    data: $FACTS"
[ -f apps/web/dist/index.html ] || pnpm --silent --filter @wheelhouse/web build >/dev/null 2>&1
start_app "$W/pglite-app" "" && ok "the new app started on the copy (migrations: nothing to do, schema is the same)" || { bad "the app did not start"; }
curl -fsS "$BASE/login" | grep -q '<div id="root">' && ok "the same process serves the React app (one port, as it will on cutover)" || bad "the React app is not served (build apps/web first)"
[ "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/app/me")" = 401 ] && ok "and the web API answers signed out (401)" || bad "the web API did not answer"
KEY="$(node -e 'const c=JSON.parse(require("fs").readFileSync(process.env.HOME+"/.config/wheelhouse/credentials.json","utf8")); process.stdout.write(Object.values(c)[0])')"
code="$(curl -s -o "$W/projects.json" -w '%{http_code}' -X POST -H "Authorization: Bearer $KEY" -H 'content-type: application/json' -d '{}' "$BASE/api/v1/list_projects")"
[ "$code" = 200 ] && ok "the existing API key authenticates ($(node -e 'const p=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); console.log((p.data??[]).map(x=>x.key).join(", "))' "$W/projects.json"))" || bad "the existing API key was refused ($code)"
node --input-type=module -e '
  const f = JSON.parse(process.argv[1]); const base = process.argv[2]; const key = process.argv[3];
  if (!f.mine) { console.log("  skip the API key in ~/.config/wheelhouse/credentials.json is not in this data"); process.exit(0); }
  let bad = 0;
  for (const p of f.mine.projects) {
    const r = await fetch(base + "/api/v1/get_changes", { method: "POST", headers: { authorization: "Bearer " + key, "content-type": "application/json" }, body: JSON.stringify({ project: p.project }) });
    const c = (await r.json()).data ?? {}; // the /api/v1 envelope
    const same = r.status === 200 && c.cursor === p.cursor && c.total === p.waiting;
    if (!same) bad++;
    console.log(`  ${same ? "ok  " : "FAIL"} ${p.project}: the key resumes at its cursor ${p.cursor} (the server says ${c.cursor}) with ${p.waiting} change(s) waiting (the server says ${c.total}); newest event ${f.maxSeq}`);
  }
  process.exit(bad ? 1 : 0)' "$FACTS" "$BASE" "$KEY" || fail=1
# The next webhook lands on the right project: a pull request naming an open ticket, from the connected repository, signed with the real secret.
( set -a; [ -f .env.local ] && . ./.env.local; set +a; node scripts/rehearsal/webhook.mjs "$FACTS" "$BASE" ) || fail=1
stop_app
done_step

step "6. the contract suite against the app on the imported and re-mapped copy (its fixtures are added to the copy)"
rm -rf "$W/contract" && mkdir -p "$W/contract"
cp -R "$W/pglite-mapped" "$W/contract/db"
pnpm --silent test:contract prepare --dir "$W/contract" --fake-port "$PORT_FAKE" > "$W/prepare.log" 2>&1 || { bad "could not add the contract fixtures to the copy"; tail -5 "$W/prepare.log"; }
( set -a; . "$W/contract/server.env"; set +a; PORT="$PORT_APP" HOST=127.0.0.1 exec pnpm --silent --filter @wheelhouse/api exec tsx src/main.ts ) > "$W/app2.log" 2>&1 &
APP_PID=$!
for _ in $(seq 1 60); do curl -fsS -m 2 "$BASE/api/health" >/dev/null 2>&1 && break; sleep 1; done
pnpm --silent test:contract --suite all --base-url "$BASE" --fixtures "$W/contract/fixtures.json" --fake-port "$PORT_FAKE" > "$W/contract.log" 2>&1
grep -E "^ℹ (tests|pass|fail)" "$W/contract.log" | tr '\n' ' '; echo
if grep -qE "^ℹ fail 0" "$W/contract.log" && ! grep -qE "^ℹ fail [1-9]" "$W/contract.log"; then ok "the contract suite passes on the imported data"; else bad "the contract suite had failures (see $W/contract.log)"; grep -E "^✖|^  ✖" "$W/contract.log" | head -10; fi
stop_app
done_step

echo
echo "total $(( $(date +%s) - T0 ))s"
[ "$fail" = 0 ] && echo "REHEARSAL $NAME: PASSED" || echo "REHEARSAL $NAME: FAILED"
exit "$fail"
