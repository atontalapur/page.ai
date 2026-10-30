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

## Notes

- `cacheComponents` and `partialPrefetching` are off, so a seeded bug reproduces the same
  way on every request.
- Imports use `.ts` extensions so `scripts/db.ts` runs on plain Node 24 with no build step.
- Keep this folder self-contained: it gets mirrored to its own repo for agent PRs (#10).
