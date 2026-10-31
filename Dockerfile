# syntax=docker/dockerfile:1
# One image for the two-app layout (ADR-16): the NestJS API serves the React build itself, so there is one container, one
# port and one origin, and the proxy in front only has to forward. Same environment variables, paths and health check as before.
FROM node:24-alpine AS base
RUN corepack enable
WORKDIR /app

# The manifests alone, so the install layer is cached until a dependency changes. A workspace install needs every package.json.
FROM base AS manifests
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/api-client/package.json packages/api-client/package.json
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json

# Build the React app (needs the dev dependencies of web, api-client and shared).
FROM manifests AS build
RUN --mount=type=cache,target=/root/.local/share/pnpm/store pnpm install --frozen-lockfile --filter @wheelhouse/web...
COPY packages packages
COPY apps/web apps/web
RUN pnpm --filter @wheelhouse/web build

# Only what the API needs at run time, as a standalone folder: its production dependencies, with @wheelhouse/shared copied in
# (it is TypeScript source, run with tsx, which is therefore a production dependency).
FROM manifests AS api
RUN --mount=type=cache,target=/root/.local/share/pnpm/store pnpm install --frozen-lockfile --filter @wheelhouse/api...
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN pnpm --filter @wheelhouse/api deploy --legacy --prod /out

FROM node:24-alpine AS run
WORKDIR /app
ENV NODE_ENV=production PORT=3000 HOST=0.0.0.0 \
    WHEELHOUSE_MIGRATIONS_DIR=/app/drizzle WEB_DIST=/app/web
RUN addgroup -S app && adduser -S app -G app
COPY --from=api --chown=app:app /out /app
COPY --from=build --chown=app:app /app/apps/web/dist /app/web
RUN mkdir -p /app/.data/uploads && chown -R app:app /app/.data
USER app
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1
# node itself is PID 1 (not pnpm, not a shell), so SIGTERM reaches the shutdown hook that closes the database cleanly.
CMD ["node", "--import", "tsx", "src/main.ts"]
