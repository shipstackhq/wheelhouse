#!/usr/bin/env bash
# The contract suite (the frozen /mcp, /api/v1, webhook, GitHub connect and stream contract, and the web app's /api/app) against
# the PACKAGED app: the image, on a real Postgres, behind Caddy, with the fake GitHub on the host (WH-99).
#   deploy/contract-in-docker.sh               # builds wheelhouse:smoke from this checkout first
#   IMAGE=ghcr.io/shipstackhq/wheelhouse:<sha> deploy/contract-in-docker.sh    # or tests a published image
# Needs Docker. Everything it starts is removed at the end. On Linux the host must be reachable as host.docker.internal
# (the server script adds it); on Docker Desktop it already is.
set -euo pipefail
cd "$(dirname "$0")/.."
export IMAGE="${IMAGE:-wheelhouse:smoke}"
export CONTRACT_NET=whcontract CONTRACT_PG_NAME=whc-pg CONTRACT_PG_PORT=55432
FAKE_PORT="${FAKE_PORT:-4599}"
export CONTRACT_GITHUB_WEB_URL="http://host.docker.internal:$FAKE_PORT"   # how the app container names the fake GitHub
export CONTRACT_FAKE_HOST=0.0.0.0   # the fake GitHub must be reachable from containers, not just from this machine
cleanup() { docker rm -f whc-pg >/dev/null 2>&1 || true; docker ps -aq --filter name=whc- | xargs -r docker rm -f >/dev/null 2>&1 || true; docker network rm whcontract >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup
[ "${IMAGE}" != "wheelhouse:smoke" ] || docker build -t wheelhouse:smoke .
docker network create whcontract >/dev/null
docker run -d --name whc-pg --network whcontract -p "127.0.0.1:$CONTRACT_PG_PORT:5432" -e POSTGRES_PASSWORD=pw postgres:18 >/dev/null
for _ in $(seq 1 40); do docker exec whc-pg pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done
sleep 2
for n in 1 2; do docker exec whc-pg psql -U postgres -qc "create database wh_p$n" >/dev/null; done
pnpm test:contract --fake-port "$FAKE_PORT" --suite "${SUITE:-all}" ${ONLY:+--only "$ONLY"} \
  --database-url "postgres://postgres:pw@127.0.0.1:$CONTRACT_PG_PORT/wh_p{PASS}" \
  --server-cmd "deploy/contract-server.sh {PORT}"
