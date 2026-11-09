# orchestrator

NestJS (Fastify adapter) service that owns the issue lifecycle. It stores issues in Postgres
through Kysely, moves them through a state machine, and queues fix jobs on pg-boss for
`apps/node` daemons to claim.

## Modules

`AppModule` serves `/health` and `/issues` and imports seven feature modules. Each one is
still a stub: an empty service and a controller with no routes.

| Module            | Will own                                                                 |
| ----------------- | ------------------------------------------------------------------------ |
| `IngestModule`    | PostHog webhook: secret check, upsert by fingerprint, queue triage (#29) |
| `TriageModule`    | Class and severity by model with a rule fallback, then notify (#30)      |
| `RunsModule`      | Steps, diffs and results the node daemon streams back per run (#8)       |
| `TiersModule`     | Escalation after a run: up a tier, or to failed past Tier 3              |
| `ApprovalsModule` | Tier 3 requests to run gated host tools, and their decisions             |
| `NotifyModule`    | Twilio call and SMS to on-call, once per issue (#31)                     |
| `GatewayModule`   | Socket.IO events to and from the UI and node daemons (#34)               |

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
queue uses pg-boss's `singleton` policy keyed on `fingerprint`, so an issue has at most one
active fix job.

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

## Test

- `pnpm --filter @page/orchestrator test` runs on PGlite (in-memory Postgres), pg-boss
  included, so it needs no database.
- `pnpm --filter @page/orchestrator test:integration` runs against `DATABASE_URL` in
  throwaway schemas, and claims a queued job the way `apps/node` will.
