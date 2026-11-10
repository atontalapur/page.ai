# orchestrator

NestJS (Fastify adapter) service that owns the issue lifecycle. It stores issues in Postgres
through Kysely, moves them through a state machine, and queues fix jobs on pg-boss for
`apps/node` daemons to claim.

## Modules

`AppModule` serves `/health`, `/issues` and `/ingest/posthog`, and imports seven feature modules.
Ingest, triage and notify are wired. The other four are still stubs.

| Module            | Owns                                                                      |
| ----------------- | ------------------------------------------------------------------------- |
| `IngestModule`    | `POST /ingest/posthog`: secret check, upsert by fingerprint, queue triage |
| `TriageModule`    | Class and severity by model with a rule fallback, then notify             |
| `RunsModule`      | Steps, diffs and results the node daemon streams back per run (#8). Stub. |
| `TiersModule`     | Escalation after a run: up a tier, or to failed past Tier 3. Stub.        |
| `ApprovalsModule` | Tier 3 requests to run gated host tools, and their decisions. Stub.       |
| `NotifyModule`    | Twilio call and SMS to on-call, one notify job per fingerprint            |
| `GatewayModule`   | Socket.IO events to and from the UI and node daemons (#34). Stub.         |

## Issue lifecycle

```
new ──────triage─▶ triaged ─start_fix─▶ fixing (tier 1)
                                         │  ▲
                              patch_ready│  │escalate / reject (tier + 1)
                                         ▼  │
                                  awaiting_approval ─approve─▶ resolved

pr_open takes approve and reject like awaiting_approval; nothing enters it yet
escalate or reject at tier 3 ─▶ failed (a human takes over)
kill from any open status    ─▶ killed
```

`src/issues/transitions.ts` holds the rules. Every applied event is written to
`issue_events`, and entering a tier queues one `fix` job (`fixJobSchema` in `@page/contracts`) in the same
transaction as the status change. The job's `runId` is also its pg-boss job id and is stored
on the issue as `current_run_id`. Entering a new tier or a terminal status cancels the job it
replaces, so a killed issue's job is never claimed and a superseded job is never retried. The
`triage`, `fix` and `notify` queues use pg-boss's `exclusive` policy keyed on `fingerprint`,
so each has at most one open job per issue. `triage` and `notify` retry 3 times with backoff.
`fix` does not retry. A call that still fails on its last try sends SMS.

The daemon's events (`patch_ready`, `escalate`) carry the `runId` of the job they report on.
An event for any run other than the current one returns 409, so a retried `escalate` cannot
skip a tier. A repeat report with the
same `fingerprint` bumps `occurrences` on the open issue; after a terminal status it opens a
new one.

## API

| Method | Path                 | Body                                       |
| ------ | -------------------- | ------------------------------------------ |
| GET    | `/health`            |                                            |
| POST   | `/issues`            | `{ fingerprint, title }`                   |
| GET    | `/issues?status=`    |                                            |
| GET    | `/issues/:id`        |                                            |
| GET    | `/issues/:id/events` |                                            |
| POST   | `/issues/:id/events` | an `issueEvent`, e.g. `{ "type": "kill" }` |
| POST   | `/ingest/posthog`    | a PostHog `$exception` webhook             |

Bodies are validated against the zod contracts (400). Unknown ids return 404. Events the
current status doesn't allow, and daemon events for a stale run, return 409. `GET /issues`
returns at most 200 issues, most recently updated first; a repeat report counts as an update.

## Run locally

```sh
pnpm db:up                                  # repo root, starts Postgres
cp .env.example .env                        # repo root, if you haven't
pnpm --filter @page/orchestrator dev        # builds, migrates, listens on :4000
```

Migrations in `migrations/` run on boot under an advisory lock. pg-boss installs its own
tables in the `pgboss` schema (`PGBOSS_SCHEMA`). `PORT` and `HOST` are also read from the
environment.

Nest needs legacy decorators with emitted metadata, which Node's type stripping can't run,
so the app is compiled with `tsc` to `dist/` rather than run from source.

## Configuration

`src/config.ts` reads these once at boot:

| Variable                 | Default                 | Notes                                                                 |
| ------------------------ | ----------------------- | --------------------------------------------------------------------- |
| `DATABASE_URL`           |                         | Required; a `postgres://` or `postgresql://` URL                      |
| `PORT`                   | `4000`                  | Railway sets it                                                       |
| `HOST`                   | `0.0.0.0`               |                                                                       |
| `PGBOSS_SCHEMA`          | `pgboss`                | Must match the node daemon's                                          |
| `USE_FAKE_ADAPTERS`      | `false`                 | `true`/`1`/`yes`/`on` or `false`/`0`/`no`/`off`                       |
| `LOG_LEVEL`              | `info`                  | `fatal`, `error`, `warn`, `info`, `debug`, `trace`                    |
| `POSTHOG_WEBHOOK_SECRET` |                         | Bearer secret for `POST /ingest/posthog`. Unset rejects every webhook |
| `OPENROUTER_API_KEY`     |                         | Unset, or `USE_FAKE_ADAPTERS`, uses the rule fallback                 |
| `TRIAGE_MODEL`           | `openai/gpt-4o-mini`    | Cheap model for triage                                                |
| `TRIAGE_TIMEOUT_MS`      | `8000`                  |                                                                       |
| `TWILIO_ACCOUNT_SID`     |                         | Set together with the token and from-number                           |
| `TWILIO_AUTH_TOKEN`      |                         |                                                                       |
| `TWILIO_FROM_NUMBER`     |                         |                                                                       |
| `NOTIFY_TO_NUMBERS`      |                         | Comma-separated E.164 numbers                                         |
| `DASHBOARD_URL`          | `http://localhost:3000` | Link included in the call and the SMS                                 |

A missing or bad `DATABASE_URL` stops startup with exit code 1 and one log line naming each
problem, e.g. `invalid config: DATABASE_URL is required`. As in `apps/node`, a blank var
counts as unset, so a copied `.env.example` boots. `USE_FAKE_ADAPTERS` skips OpenRouter and
Twilio. With it off, a missing key still boots: triage uses the rules and pages are recorded
instead of sent. The three Twilio vars are set together or not at all.

## Logs

pino writes JSON lines to stdout, Nest's own logs included (under a `context` field). Lines
about one issue carry `issueId`, and `runId` and `tier` once it has them; `issueLogger()` in
`src/logger.ts` adds those fields to a child logger.

## Deploy to Railway staging

`Dockerfile` builds from the repo root (`docker build -f apps/orchestrator/Dockerfile .`)
and `railway.json` gates each deploy on `/health`. Migrations run on boot, so there is no
pre-deploy step. The compiled app imports `@page/contracts` and `@page/db-migrations` as
`.ts` sources, and Node won't strip types under `node_modules`, so the image keeps the
workspace layout instead of using `pnpm deploy`. One-time service setup:

1. New service from this GitHub repo, root directory `/`.
2. Settings, Config-as-code file path: `/apps/orchestrator/railway.json`.
3. Set `DATABASE_URL=${{Postgres.DATABASE_URL}}` (the project's Postgres service). Railway
   sets `PORT`; `HOST` and `PGBOSS_SCHEMA` keep their defaults.

Don't generate a public domain yet. The API has no authentication, so anyone with the URL
could read issues and approve, reject or kill them. Keep the service on Railway's private
network until the API checks a token. The deploy health check still confirms `/health`
returns 200. A config error exits 1, and Railway retries it up to 5 times
(`ON_FAILURE`), then stops.

## Test

- `pnpm --filter @page/orchestrator test` runs on PGlite (in-memory Postgres), pg-boss
  included, so it needs no database.
- `pnpm --filter @page/orchestrator test:integration` runs against `DATABASE_URL` in
  throwaway schemas, and claims a queued job the way `apps/node` will.
