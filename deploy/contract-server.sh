#!/usr/bin/env bash
# The "server" the contract runner starts when it tests the packaged app (see deploy/contract-in-docker.sh): the app container
# and a Caddy in front of it, on the Docker network the driver made. The runner hands this script its environment (the
# database, the fake GitHub, ...); host addresses in it are rewritten to ones a container can reach. Stops both on SIGTERM.
#   deploy/contract-server.sh <port>
set -euo pipefail
cd "$(dirname "$0")/.."
PORT="${1:?port}"
NET="${CONTRACT_NET:-whcontract}"
IMAGE="${IMAGE:-wheelhouse:smoke}"
APP="whc-app-$PORT"; EDGE="whc-caddy-$PORT"
HOST_IP="host.docker.internal"
toContainer() { sed -e "s#127\.0\.0\.1:${CONTRACT_PG_PORT:-55432}#${CONTRACT_PG_NAME:-whc-pg}:5432#g" -e "s#127\.0\.0\.1#${HOST_IP}#g" -e "s#localhost#${HOST_IP}#g"; }

env_args=()
for name in DATABASE_URL ALLOW_SIGNUP ADMIN_EMAILS ANTHROPIC_API_KEY ANTHROPIC_BASE_URL \
            GITHUB_APP_ID GITHUB_APP_SLUG GITHUB_APP_PRIVATE_KEY GITHUB_WEBHOOK_SECRET GITHUB_CLIENT_ID GITHUB_CLIENT_SECRET GITHUB_API_URL GITHUB_WEB_URL; do
  [ -n "${!name+x}" ] || continue
  env_args+=(-e "$name=$(printf '%s' "${!name}" | toContainer)")
done

# The contract suite makes each test case a different person with its own X-Forwarded-For, which the shipped Caddyfile
# (correctly) would overwrite with the one address everything comes from here. So that one thing differs: the upstream gets the
# header exactly as the test sent it. Everything else (the streams, compression, timeouts) is the Caddyfile that ships.
CADDYFILE="$(sed 's#flush_interval -1#flush_interval -1\n\t\t\theader_up X-Forwarded-For {http.request.header.X-Forwarded-For}#' deploy/Caddyfile)"

stop() { docker rm -f "$EDGE" "$APP" >/dev/null 2>&1 || true; }
trap 'stop; exit 0' TERM INT
stop
docker run -d --name "$APP" --network "$NET" --add-host "$HOST_IP:host-gateway" "${env_args[@]}" -e APP_URL="http://127.0.0.1:$PORT" "$IMAGE" >/dev/null
# The config goes in by environment variable, not a bind mount: a mount of a temp file is not possible on every Docker host.
docker run -d --name "$EDGE" --network "$NET" -p "127.0.0.1:$PORT:80" -e SITE_ADDRESS=":80" -e UPSTREAM="$APP:3000" -e CADDYFILE="$CADDYFILE" \
  --entrypoint sh caddy:2-alpine -c 'printf "%s\n" "$CADDYFILE" > /tmp/Caddyfile && exec caddy run --config /tmp/Caddyfile --adapter caddyfile' >/dev/null
echo "app $APP and caddy $EDGE are up on $PORT"
docker logs -f "$APP" &
wait $!
