# Environments

Status: plan. Nothing built yet.

## Goal

From an issue, a teammate clicks **Preview** and gets a link to the PR's code running somewhere safe. They can click through the change without pulling it.

## What an Environment is

The PR's head commit, running in isolation, reachable through one link, and torn down on its own.

- **v1:** runs on the dev's device, through the daemon.
- **Later:** runs on a sandbox (cloud VM or microVM) with the same manifest and lifecycle. Only the host changes.

## 1. The repo declares how to run

The agent must not improvise infrastructure on every run. Each repo describes itself once, in `wheelhouse.json`:

```json
"preview": {
  "compose": "docker-compose.preview.yml",
  "setup": "pnpm i && pnpm db:migrate && pnpm db:seed",
  "web": { "service": "app", "port": 3000 },
  "env": ["STRIPE_TEST_KEY"]
}
```

- `compose`: the services the app needs (app, database, cache).
- `setup`: runs inside the app container after the services start.
- `web`: which service and port to tunnel.
- `env`: the secrets allowed through, by name. Use test keys only.

The agent can **draft** this block and the compose file as an ordinary PR. A human reviews and merges it. After that, every run is deterministic.

## 2. Isolation

Docker Compose is the boundary.

- Each environment is its own compose project, with its own network and volumes.
- No host filesystem mounts. The code is copied in, not bind-mounted.
- No fixed host ports. The tunnel is the only way in.
- **Databases:** a fresh container per environment, migrated and seeded by `setup`. It never touches the dev's own database.
- **External services:** only the secrets listed in `env` pass through. Anything else is absent.

A worktree-only mode without Docker may exist as a fallback, but it is labeled **not isolated** in the UI.

## 3. Lifecycle (daemon)

1. **Request:** someone clicks Preview on an issue that has a PR.
2. **Checkout:** fetch the PR head into a fresh directory.
3. **Up:** run `compose up`, then `setup`, then wait for the web port's health check.
4. **Tunnel:** open a tunnel to the web port (a Cloudflare quick tunnel first; Tailscale Funnel is an option).
5. **Report:** post the link, status and logs to the issue.
6. **Teardown:** when any of these happens:
   - the TTL ends (default 2 hours)
   - the PR is merged or closed
   - someone clicks Stop
   - a new push replaces the environment

   Teardown removes containers, volumes and the checkout.

Cap: 2–3 concurrent environments per device.

## 4. Safety

- The link is gated: only people with access to the Wheelhouse workspace can open it.
- Only PRs from the team's own repos, never forks.
- Logs from the setup and start steps stream to the issue, so a failure is visible and explains itself.
- Resource limits on containers (CPU and memory) so a preview can't take over the laptop.

## Statuses

`starting → running → stopped`, plus `failed`, which comes with the logs.

## Out of scope for v1

- Hosted sandboxes
- Multi-repo apps
- Production-like data
- Auto-detecting the stack without a manifest
- Fork PRs

## Open questions

- Gating the link: a Wheelhouse auth proxy in front of the tunnel, or a signed short-lived URL?
- Should a preview start on its own for every PR, or only on click? Start with click.
- Which device runs it when several team members have daemons online: the PR author's, or any idle one?

## Main risk

Repos without a working Docker setup. That is where the agent drafting the manifest earns its keep.
