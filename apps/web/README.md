# @wheelhouse/web

The React app (WH-94): Vite, React Router, TanStack Query, Tailwind v4. It talks only to `/api/app/*` through `@wheelhouse/api-client` and replaces the Next.js UI at cutover (WH-102).

```bash
pnpm --filter @wheelhouse/web dev        # Vite on 5173; /api and /mcp proxy to VITE_API_TARGET (default http://127.0.0.1:3460)
pnpm --filter @wheelhouse/web build      # dist/
pnpm --filter @wheelhouse/web test       # Vitest + jsdom
pnpm --filter @wheelhouse/web typecheck
```

## Shape

- `src/pages/` is a page per file (or folder): `auth` (sign-in, sign-up), `invite`, `new-project`, `team`, `agents`, `admin`, `dashboard/` (one component per widget, laid out by `registry.tsx`). They read through `lib/queries.ts` and write through the typed client; none of them knows a URL.
- Forms are React 19 form actions (`useActionState` plus `SubmitButton`, which shows the pending state). A failed call becomes a message with `lib/form-state.ts`: the server's own words (they are the Next app's), or "Cannot reach Wheelhouse" for a dropped connection.
- A page that reads one thing wraps it in `components/query-state.tsx`'s `Loaded`: a skeleton while it loads, "not found" for a 404, a message with Try again for anything else. The dashboard's widgets each load and fail on their own.
- After this browser changes something, `lib/refresh.ts` reads again whatever may show it; changes by other people arrive on the live stream.
- `src/routes/router.tsx` builds every route. Pages are `PageStub`s until their ticket lands (WH-95 board, WH-96 map, WH-97 docs, WH-98 the rest); replace the stub, keep the path.
- Guards (`routes/guards.ts`) decide in loaders: signed out goes to `/login`, signed in skips `/login`, `/admin/*` needs an admin. The session is the `["me"]` query.
- `lib/services.tsx` owns the API client and query client. When the API says the session ended, `["me"]` becomes null first, then everything else is dropped.
- Live updates: `components/live-refresh.tsx` opens the SSE stream for the team or project and invalidates every query except `me`. Pages that need to react also hear `wheelhouse:changed`.
- `app.css` is byte-identical to the Next app's `globals.css` (a test enforces it while both exist).

## PWA

`public/sw.js` caches only `/assets/*` and `/offline.html`; navigations always go to the network, and `/api` and `/mcp` are never touched. The worker registers in production builds only. Signing out wipes its caches.
