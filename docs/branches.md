# Branches: everything goes to staging, then to production

Nothing is deployed from this repository yet. This page is the branch model so that, when deploys start, there is already one rule for what runs where.

| Branch | What it is | Who writes to it |
|---|---|---|
| `production` | What runs (or will run) for customers. Always a commit that has already been on `staging`. | Only promotions from `staging`. Never a direct push, never a feature branch. |
| `staging` | The integration branch. Every change lands here first and is checked here (CI, and later a staging deployment). | Pull requests from `wh/WH-n-slug` branches. |
| `wh/WH-n-slug` | One branch per ticket, cut from `staging` (ADR-22: one branch, one PR, one worktree per ticket). | The person or agent doing the ticket. |
| `main` | Retired. Frozen at the last commit before this model (the Next.js era). Not updated any more. | Nobody. |

## The flow

```
wh/WH-n-slug ──PR──▶ staging ──promote──▶ production
```

1. Branch from `staging`, named with the ticket ref (`wh/WH-109-header-search`) so the GitHub App links it.
2. Open a pull request into `staging`. CI must pass. Review happens here.
3. When `staging` holds what should ship, **promote** it: fast-forward `production` to `staging` (`git push origin staging:production` when `production` is an ancestor of `staging`), or a pull request from `staging` into `production` if it needs a review record. Promote a commit, not a bundle of cherry-picks: `production` must never contain a commit that was not on `staging`.
4. A **hotfix** takes the same path, faster: branch from `staging`, fix, pull request, promote straight away. Do not branch from `production`: that would leave `staging` behind.
5. Release markers, when wanted, are tags on `production` commits.

## Deploys

`deploy.yml` is switched off for automatic runs and can be started by hand, only from `production`. When deploys are agreed, the intended shape is: `staging` deploys to a staging environment on every merge, `production` deploys after a promotion (with the manual approval gate the `production` environment already allows). Until then no workflow deploys anything.

CI (`ci.yml`) runs on every pull request and on every push to `staging` and `production`.

## What still has to be set on GitHub

These are repository settings, not files, and are changed by the owner:

- **Default branch.** New pull requests target the default branch. Recommended: `staging`. This is also the branch the Wheelhouse GitHub App treats as "default" (the push that lands changes and flags stale map nodes and docs), so it decides where the map follows the code. If `production` were the default, the map would only catch up at each promotion.
- **Protection.** `production`: no direct pushes, no force pushes, require the CI checks. `staging`: no force pushes, require the CI checks and a pull request.
- **The Wheelhouse repository record** (`default_branch`, now `main`) must be changed to the same branch.

## Why this shape

One path to production means a deploy is always a promotion of something already exercised on `staging`, rollback is "promote the previous commit", and an agent's pull request has exactly one target. It also matches how Wheelhouse lands work: a branch and a pull request per ticket, reviewed before it is merged.
