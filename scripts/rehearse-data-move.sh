#!/usr/bin/env bash
# One full rehearsal of a data move on a COPY of Wheelhouse's data, timed, with every check the cutover needs (WH-100; extended
# for the foundation migrations 0018 to 0022 in WH-116: preflight, constraints, the database suites on the imported data, the image).
#   scripts/rehearse-data-move.sh <PGlite directory of the source> [rehearsal name]
# REHEARSAL_BASE=<git ref>   the code the source's map was last anchored to (default: where this branch left staging)
# REHEARSAL_RESOLVE=0        do not resolve dangling references; a preflight that finds some then fails the rehearsal
# REHEARSAL_SKIP_IMAGE=1     skip the Docker image check (step 8)
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

BASE_REF="${REHEARSAL_BASE:-$(git merge-base HEAD staging)}"
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

step "0. bring a COPY of the source to the state just before the new constraints (migration 0020)"
NOTE=""
if [[ "$SOURCE" != postgres* ]]; then
  cp -R "$SOURCE" "$W/source-migrated" && SOURCE="$W/source-migrated"
  # Only up to 0020: the export refuses to cross migrations, and the preflight below must see the data as 0021 and 0022 will.
  db migrate --to "$SOURCE" --through 0020 || { bad "migrate the source copy to 0020"; exit 1; }
fi
done_step

step "0b. preflight: every row the new constraints (0021, 0022) would refuse, reported before anything is applied"
if [[ "$SOURCE" != postgres* ]]; then
  if db preflight --to "$SOURCE" > "$W/preflight.log"; then
    ok "preflight: nothing in the data breaks migrations 0021 or 0022"
  else
    grep "FAIL" "$W/preflight.log" | sed 's/^/    /'
    if [ "${REHEARSAL_RESOLVE:-1}" = 1 ]; then
      db preflight --to "$SOURCE" --resolve | grep -E "RESOLVED|^removed" | sed 's/^/    /'
      db preflight --to "$SOURCE" > "$W/preflight2.log" && ok "after --resolve the preflight is clean (the cutover does the same on the real database)" || bad "the preflight still fails after --resolve"
      NOTE="dangling references were found, listed above, and resolved on the copy"
    else
      bad "preflight found rows the new constraints refuse (REHEARSAL_RESOLVE=0)"
    fi
  fi
  db migrate --to "$SOURCE" || { bad "apply the rest of the migrations to the source copy"; exit 1; }
  ok "migrations 0021 and 0022 applied to the copy"
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

step "4b. the database suites on the real Postgres that holds the imported data (as CI runs them, on top of the real rows)"
TEST_DATABASE_URL="$PGURL" pnpm --silent exec tsx --conditions=react-server --test --test-force-exit --test-concurrency=1 \
  packages/core/src/lib/queue.test.ts tests/invites.test.ts packages/core/src/lib/workspaces-admin.test.ts tests/isolation.test.ts \
  packages/core/src/lib/version-lock.test.ts packages/core/src/tools/db-copy.test.ts packages/core/src/lib/workspace-scope.test.ts \
  packages/core/src/lib/constraints.test.ts packages/core/src/lib/join-tables.test.ts packages/core/src/lib/cycles.test.ts packages/core/src/lib/projects.test.ts packages/core/src/lib/initiatives.test.ts packages/core/src/lib/team-access.test.ts > "$W/dbsuites.log" 2>&1
grep -E "^ℹ (tests|pass|fail)" "$W/dbsuites.log" | tr '\n' ' '; echo
if grep -qE "^ℹ fail 0" "$W/dbsuites.log"; then ok "the database suites pass on Postgres 18 with the imported data in it"; else bad "database suites failed on Postgres (see $W/dbsuites.log)"; grep -E "^✖|^  ✖" "$W/dbsuites.log" | head -10; fi
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
pnpm --silent map:reanchor --db "$W/pglite-app" --from "$BASE_REF" --to HEAD --rules docs/reanchor-rules.json --apply > "$W/reanchor.log" 2>&1 && ok "map:reanchor --apply: $(grep -c '^node\|^doc' "$W/reanchor.log") node(s) and doc(s) re-anchored, every anchor resolved" || { bad "map:reanchor left anchors unresolved"; tail -6 "$W/reanchor.log"; }
pnpm --silent map:reanchor --db "$W/pglite-app" --from "$BASE_REF" --to HEAD --rules docs/reanchor-rules.json > "$W/reanchor2.log" 2>&1 && ! grep -q '^node\|^doc' "$W/reanchor2.log" && ok "a second map:reanchor plans nothing" || bad "map:reanchor is not idempotent"
pnpm --silent map:after-migration --db "$W/pglite-app" > "$W/after-migration.log" 2>&1 && ok "map:after-migration: $(grep -c '^  done' "$W/after-migration.log") change(s) to what the map says" || { bad "map:after-migration failed"; tail -5 "$W/after-migration.log"; }
pnpm --silent map:after-migration --db "$W/pglite-app" 2>&1 | grep -q "nothing to change" && ok "and a second run changes nothing" || bad "map:after-migration is not idempotent"
db verify --to "$W/pglite-app" --integrity-only | tail -1 | grep -q "integrity holds" && ok "integrity still holds after the map was updated" || bad "integrity after the map update"
cp -R "$W/pglite-app" "$W/pglite-mapped"
# What the data says before the app touches it: the real key's cursor, the newest event, a connected repository, an open issue.
FACTS="$(node scripts/rehearsal/facts.mjs "$W/pglite-app")"
echo "    data: $FACTS"
[ -f apps/web/dist/index.html ] || pnpm --silent --filter @wheelhouse/web build >/dev/null 2>&1
start_app "$W/pglite-app" "" && ok "the new app started on the copy (migrations: nothing to do, the copy is already at this code's)" || { bad "the app did not start"; }
curl -fsS "$BASE/login" | grep -q '<div id="root">' && ok "the same process serves the React app (one port, as it will on cutover)" || bad "the React app is not served (build apps/web first)"
[ "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/app/me")" = 401 ] && ok "and the web API answers signed out (401)" || bad "the web API did not answer"
KEY="$(node -e 'const c=JSON.parse(require("fs").readFileSync(process.env.HOME+"/.config/wheelhouse/credentials.json","utf8")); process.stdout.write(Object.values(c)[0])')"
code="$(curl -s -o "$W/teams.json" -w '%{http_code}' -X POST -H "Authorization: Bearer $KEY" -H 'content-type: application/json' -d '{}' "$BASE/api/v1/list_projects")"
[ "$code" = 200 ] && ok "the existing API key authenticates ($(node -e 'const p=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); console.log((p.data??[]).map(x=>x.key).join(", "))' "$W/teams.json"))" || bad "the existing API key was refused ($code)"
node --input-type=module -e '
  const f = JSON.parse(process.argv[1]); const base = process.argv[2]; const key = process.argv[3];
  if (!f.mine) { console.log("  skip the API key in ~/.config/wheelhouse/credentials.json is not in this data"); process.exit(0); }
  let bad = 0;
  for (const p of f.mine.teams) {
    const r = await fetch(base + "/api/v1/get_changes", { method: "POST", headers: { authorization: "Bearer " + key, "content-type": "application/json" }, body: JSON.stringify({ project: p.team }) });
    const c = (await r.json()).data ?? {}; // the /api/v1 envelope
    const same = r.status === 200 && c.cursor === p.cursor && c.total === p.waiting;
    if (!same) bad++;
    console.log(`  ${same ? "ok  " : "FAIL"} ${p.team}: the key resumes at its ${p.has_cursor ? "cursor" : "starting point (no cursor row yet)"} ${p.cursor} (the server says ${c.cursor}) with ${p.waiting} change(s) waiting (the server says ${c.total}); newest event ${f.maxSeq}`);
  }
  process.exit(bad ? 1 : 0)' "$FACTS" "$BASE" "$KEY" || fail=1
# The next webhook lands on the right team: a pull request naming an open issue, from the connected repository, signed with the real secret.
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

if [ "${REHEARSAL_SKIP_IMAGE:-0}" != 1 ]; then
step "8. the image builds and starts against a fresh Postgres, serves the app, and applies every migration (as CI's image job does)"
IMG="wheelhouse:rehearsal"
if docker build -q -t "$IMG" . > "$W/image-build.log" 2>&1; then ok "the image built"; else bad "the image did not build"; tail -5 "$W/image-build.log"; fi
PG2="whrehearsal-img-$$"; APPC="whrehearsal-app-$$"
docker run -d --name "$PG2" -p "127.0.0.1:$((PORT_PG + 1)):5432" -e POSTGRES_PASSWORD=pw -e POSTGRES_DB=wheelhouse postgres:18 >/dev/null
for _ in $(seq 1 40); do docker exec "$PG2" pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done; sleep 2
docker run -d --name "$APPC" -p "127.0.0.1:$((PORT_APP + 2)):3000" -e DATABASE_URL="postgres://postgres:pw@host.docker.internal:$((PORT_PG + 1))/wheelhouse" -e APP_URL="http://127.0.0.1:$((PORT_APP + 2))" "$IMG" >/dev/null
IMGBASE="http://127.0.0.1:$((PORT_APP + 2))"
healthy=0; for _ in $(seq 1 45); do curl -fsS -m 2 "$IMGBASE/api/health" >/dev/null 2>&1 && { healthy=1; break; }; sleep 2; done
[ "$healthy" = 1 ] && ok "health is 200 on an empty Postgres once the migrations applied" || { bad "the image did not become healthy"; docker logs "$APPC" 2>&1 | tail -8; }
curl -fsS "$IMGBASE/t/WH/map" | grep -q '<div id="root">' && ok "the same container serves the React app at /t/…" || bad "the React app is not served by the image"
[ "$(curl -s -o /dev/null -w '%{http_code}' "$IMGBASE/api/app/me")" = 401 ] && ok "and the web API answers signed out (401)" || bad "the web API did not answer in the image"
expected=$(node -p "require('./packages/core/drizzle/meta/_journal.json').entries.length")
applied=$(docker exec -e PGPASSWORD=pw "$PG2" psql -U postgres -d wheelhouse -tAc 'select count(*) from drizzle.__drizzle_migrations' | tr -d ' ')
[ "$expected" = "$applied" ] && ok "every migration was applied ($applied of $expected)" || bad "migrations applied: $applied of $expected"
docker rm -f "$APPC" "$PG2" >/dev/null 2>&1
done_step
fi

echo
[ -n "${NOTE:-}" ] && echo "note: $NOTE"
echo "total $(( $(date +%s) - T0 ))s"
[ "$fail" = 0 ] && echo "REHEARSAL $NAME: PASSED" || echo "REHEARSAL $NAME: FAILED"
exit "$fail"
