# @wheelhouse/web

The React app (WH-94): Vite, React Router, TanStack Query, Tailwind v4. It talks only to `/api/app/*` through `@wheelhouse/api-client` and replaced the Next.js UI (archived at the git tag `archive/next-app`).

```bash
pnpm --filter @wheelhouse/web dev        # Vite on 5173; /api and /mcp proxy to VITE_API_TARGET (default http://127.0.0.1:3460)
pnpm --filter @wheelhouse/web build      # dist/
pnpm --filter @wheelhouse/web test       # Vitest + jsdom
pnpm --filter @wheelhouse/web typecheck
```

## Shape

- `src/pages/` is a page per file (or folder): `auth` (sign-in, sign-up), `invite`, `new-team`, `workspace`, `agents`, `admin`, `dashboard/` (one component per widget, laid out by `registry.tsx`), `board/` (the kanban board, its issue dialog and the pure rules of a drag in `board-state.ts`), `map/`, `decisions/`, `glossary/`, `activity/`, `docs/` (the doc tree and editor; `file-tree.ts` holds the pure parts), `repos/` (repositories and the Connect GitHub card) and `onboarding/` (the wizard, which reuses the repos and GitHub components). They read through `lib/queries.ts` and write through the typed client; none of them knows a URL.
- Forms are React 19 form actions (`useActionState` plus `SubmitButton`, which shows the pending state). A failed call becomes a message with `lib/form-state.ts`: the server's own words (they are the Next app's), or "Cannot reach Wheelhouse" for a dropped connection.
- A page that reads one thing wraps it in `components/query-state.tsx`'s `Loaded`: a skeleton while it loads, "not found" for a 404, a message with Try again for anything else. The dashboard's widgets each load and fail on their own.
- After this browser changes something, `lib/refresh.ts` reads again whatever may show it; changes by other people arrive on the live stream.
- `src/routes/router.tsx` builds every route, at the Next app's own addresses. Every page is ported (WH-95 to WH-98); a page still to come would be a placeholder component, then replaced keeping its path.
- Guards (`routes/guards.ts`) decide in loaders: signed out goes to `/login`, signed in skips `/login`, `/admin/*` needs an admin. The session is the `["me"]` query.
- `lib/services.tsx` owns the API client and query client. When the API says the session ended, `["me"]` becomes null first, then everything else is dropped.
- Live updates: `components/live-refresh.tsx` opens the SSE stream for the workspace or team and invalidates every query except `me`. Pages that need to react also hear `wheelhouse:changed`.
- `app.css` holds the design tokens and styles; it started as the Next app's `globals.css`, unchanged.

## PWA

`public/sw.js` caches only `/assets/*` and `/offline.html`; navigations always go to the network, and `/api` and `/mcp` are never touched. The worker registers in production builds only. Signing out wipes its caches.

## The board

The board keeps a local copy of the issues so a drag moves cards at once. The server's copy replaces it whenever nothing is being dragged (that is how an agent's or a teammate's change shows up: the live stream refreshes the board query), and again, with the real positions, when a drop has been saved. The issue dialog is its own query (`["issue", ref]`), so it follows the stream too; an edit in progress is never overwritten (a title being typed is kept, and a description edit that started on an older version warns and is refused on save). `?t=` names the open issue. Every edit sends the `version` it was made from; a stale one is a 409 whose `current` the dialog shows.

dnd-kit's pointer sensor cannot be driven in jsdom, so the rules of a drag are pure functions in `pages/board/board-state.ts` with their own tests, and the real drag (into an empty column, into a populated one, within one) was checked in a browser.

## Docs, repositories and onboarding

The docs page keeps the open doc's id in state and reads it as its own query (`["doc", key, id]`), so it follows the live stream like the issue dialog: while someone is editing, a change made by anyone else raises the "this doc changed while you were editing" banner and the save is refused by the server (`version`), never overwritten. The editor is the shared `DescriptionEditor` (rich text or Markdown, loaded on demand). The anchor picker lists a GitHub repository's files through the API; the app never talks to GitHub.

The Connect GitHub card reads `GET /repositories/github` (whether GitHub is set up here, and for owners the repositories each installation can still connect) and sends the person to `/api/github/install` with a plain link, because that leaves the app for GitHub and returns through the API's callback, which redirects back to `/t/KEY/repos?github=...`. The page turns those parameters into its notes.
