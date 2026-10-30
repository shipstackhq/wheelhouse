# Shipstack Loves Open Source

Free Wheelhouse (teams plan) for open-source projects and their maintainers, with a public, read-only view of their work. Mainly marketing;
not designed in detail yet.

## Why

- Distribution: every public board is a live demo and a backlink.
- Goodwill with maintainers, who are often the people choosing tools at their day jobs.
- Useful to contributors: a clear view of what is planned and what is ready to pick up.

## Who qualifies

A public GitHub repository with an OSI-approved license, checked through the existing GitHub integration. Maintainers apply. We approve and
can revoke.

## The public view

- A public URL per project (for example `/oss/<org>/<project>`).
- **Read-only.** The public cannot write anything to Wheelhouse. Suggestions and discussion happen on GitHub (issues, discussions, PRs), and
  public pages link there.
- Starts with issues: list, detail, status, cycle. Later, possibly the dependency graph and a "Ready now" list for contributors.

## Privacy

- Opt in per team or project, never the whole workspace.
- Maintainers can hide individual issues and fields. Internal comments, agent notes and runs are never public.
- Clearly marked in the app, so nobody forgets which parts are public.

## Security

Public pages use their own narrow, read-only API that returns only the fields cleared for the public. They do not reuse the app API with
auth switched off. Cached and rate limited.

## Risks

- Leaking private data. Covered by opt-in, a separate API and a whitelist of fields.
- Abuse of the free plan. Covered by approval and repo checks.

## Scope for a first version

Application and approval, the opt-in switch, public issue list and detail pages, links out to GitHub.
