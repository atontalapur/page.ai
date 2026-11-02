# demo-app

The Next.js + Postgres shop that PageAgents treats as production. Seeded bugs break it on
four surfaces: pages (frontend), `/api/*` route handlers (backend), SQL and constraints
(database), and env settings in `src/config.ts` (config).

## Run locally

```sh
docker compose up              # from the repo root: Postgres + app on :3000
```

Or against the compose Postgres with hot reload:

```sh
pnpm db:up                     # repo root
cp apps/demo-app/.env.example apps/demo-app/.env
pnpm --filter @page/demo-app db:migrate   # creates the `demo` database on first run
pnpm --filter @page/demo-app db:seed      # resets the catalogue and stock
pnpm --filter @page/demo-app dev
```

## Test

- `pnpm --filter @page/demo-app test` runs unit tests on PGlite (in-memory Postgres), so
  it passes offline, including inside the sandbox under `--network none`.
- `pnpm --filter @page/demo-app test:integration` runs against `DATABASE_URL` in its own
  throwaway schema.

## Deploy to Railway staging

`railway.json` builds `Dockerfile` from the repo root, runs migrations and the seed before
each deploy, and gates on `/api/health`. One-time service setup:

1. New service from this GitHub repo, root directory `/`.
2. Settings, Config-as-code file path: `/apps/demo-app/railway.json` (Railway does not
   find it on its own outside the root).
3. Add a Postgres service and set `DATABASE_URL=${{Postgres.DATABASE_URL}}` on this one.
4. Generate a public domain. Optional shop settings are listed in `.env.example`.
5. Set `POSTHOG_KEY` (and `POSTHOG_HOST` if the project isn't on US cloud) so errors
   reach PostHog Error Tracking. Railway's `RAILWAY_GIT_COMMIT_SHA` tags each error with
   its release.

## Error reporting

`src/instrumentation.ts` reports every unhandled server error (pages, route handlers,
server actions) through `onRequestError`, tagged with the route file path, release and
error name. In the browser, posthog-js captures uncaught errors and unhandled
rejections, and `global-error.tsx` reports what React catches. Both go through an
`ErrorReporter` (`src/observability/`) that falls back to an in-memory fake when
`POSTHOG_KEY` is unset. A `ShopError` is a 4xx, not a crash, so it is never reported.

## Notes

- `cacheComponents` and `partialPrefetching` are off, so a seeded bug reproduces the same
  way on every request.
- Imports use `.ts` extensions so `scripts/db.ts` runs on plain Node 24 with no build step.
- Keep this folder self-contained: it gets mirrored to its own repo for agent PRs (#10).
