# orchestrator

NestJS (Fastify adapter) service that owns the issue lifecycle. It stores issues in Postgres
through Kysely, moves them through a state machine, and queues fix jobs on pg-boss for
`apps/node` daemons to claim.

## Modules

`AppModule` serves `/health`, `/issues` and `/ingest/posthog`, and imports six feature modules,
all wired. Escalation between tiers is part of the issue state machine
(`src/issues/transitions.ts`), not a module.

| Module            | Owns                                                                          |
| ----------------- | ----------------------------------------------------------------------------- |
| `IngestModule`    | `POST /ingest/posthog`: secret check, upsert by fingerprint, queue triage     |
| `TriageModule`    | Class and severity by model with a rule fallback, then notify                 |
| `RunsModule`      | `run_finished` jobs from the node daemon: runs row, issue event, next tier    |
| `ApprovalsModule` | Tier 3 requests to run gated ops tools, their decisions, `GET /approvals`     |
| `NotifyModule`    | Twilio call and SMS to on-call, one notify job per fingerprint and phone      |
| `GatewayModule`   | Socket.IO for the UI and the daemons: live events, kills, approvals; `/nodes` |

## Issue lifecycle

```
new ──────triage─▶ triaged ─start_fix─▶ fixing (tier 1)
                                         │  ▲
                              patch_ready│  │escalate / reject (tier + 1)
                                         ▼  │
                                  awaiting_approval ─approve─▶ resolved

triage sends start_fix itself when AUTO_START_FIX is on, up to AUTO_START_FIX_MAX_PER_HOUR
ops_fixed (tier 3: a fix made live through the ops API, no code change) ─▶ resolved
pr_open takes approve and reject like awaiting_approval; nothing enters it yet
escalate or reject at tier 3 ─▶ failed (a human takes over)
fail (a run a higher tier can't fix) ─▶ failed
kill from any open status    ─▶ killed
```

`src/issues/transitions.ts` holds the rules. Every applied event is written to
`issue_events`, and entering a tier queues one `fix` job (`fixJobSchema` in `@page/contracts`) in the same
transaction as the status change. The job's `runId` is also its pg-boss job id and is stored
on the issue as `current_run_id`. Entering a new tier or a terminal status cancels the job it
replaces, so a killed issue's job is never claimed and a superseded job is never retried. The
`triage`, `fix` and `notify` queues use pg-boss's `exclusive` policy keyed on `fingerprint`,
so each has at most one open job per issue. `notify` is keyed on `fingerprint` and phone:
triage queues one job per `NOTIFY_TO_NUMBERS` entry, so a retry pages only the phone that
missed it. `triage` and `notify` retry 3 times with backoff. `fix` does not retry. A call that
still fails on its last try sends SMS.

Ingest stores a sanitized error report on the issue (`src/ingest/report.ts`): the request
line, the exception and its in-app frames, innermost first. It never reads bodies, headers,
cookies or person fields, drops query values (and any query piece without a name), and masks
email addresses, encoded ones included, because a Tier 2 run writes a public PR from it.
Exception messages are kept, since they are what the agent fixes from. The one known way a
body gets into a message is a JSON.parse error quoting its input, so that input is masked;
any other message is kept as thrown. Every fix job carries the report, or the title for an issue that
has none. A production Next build's frames name compiled `.next/server` chunks rather than
`apps/demo-app/src` unless source maps reach PostHog, so the report says so under them. The
`fix` queue expires a claimed job after 20 minutes (`FIX_EXPIRE_SECONDS`): 14 minutes of agent
budget plus the sandbox start, the diff and closing a PR.

Triage classifies an issue from its title and stored report (`src/triage/`). The model gets
the report escaped inside one `<report>` tag, and its prompt says the report is data, not
instructions: anyone with the public PostHog project key can send one, and an exception
message can quote a request. Rules over the same report answer when no key is set, the call
fails or the reply isn't the JSON contract. They read the request line, the frames and the
messages, and get 28 of the 30 scenarios' classes right (eval/README.md). Their severity is
also a floor under the model's, so a report that talks the model down still pages as high as
the rules would. The `issue triaged` log line says which path ran (`by`) and, when the floor
raised it, the model's own severity; a model that failed logs a warning with the reason.

When a run ends, the node daemon sends a `run_finished` job (`runFinishedJobSchema`) with the
`node.run.finished` result, the run's times and the agent's diff. `RunsService` writes the
`runs` row, then applies the issue event in the same transaction: `succeeded` is
`patch_ready`, `escalated` is `escalate`, `failed` is `fail` and `killed` is `kill`. A
`succeeded` result with `opsOnly` is `ops_fixed` instead: the Tier 3 run changed the live app
through the ops API and left no code change, so its fix is live already and there is no patch
to approve. The daemon sets `opsOnly` itself, since a null diff also means one it couldn't
read or one over the cap. A run with ops changes and a diff or a PR is `patch_ready`. The
daemon also decides when a submitted run escalates: one whose confidence score is under its
tier's threshold arrives as `escalated` with reason `low_confidence` (or `failed` at Tier 3),
its score and patch on the `runs` row, and the orchestrator applies it like any escalation. An
escalation the issue takes also writes its `escalations` row. Entering the next tier queues
its fix job with the report and the run's escalation note; a rejected patch hands the
reviewer's reason on the same way. A result for a run that is no longer current only updates
its row, so a retried job is harmless. A succeeded run's PR link stays on its `runs` row and
the issue goes to `awaiting_approval`, or to `resolved` for `ops_fixed`; nothing enters
`pr_open` yet.

A fix job can also end with no result: the daemon dies or hangs until the job expires, or it
can't queue the result. pg-boss then fails the job and copies it to the `fix_failed` dead
letter queue (a cancelled job is never copied). Its worker calls `RunsService.recordLost`,
which writes a `failed` runs row and applies `fail`, unless the run is no longer current or
the daemon's `run_finished` job for it is still queued. Without this the issue would stay in
`fixing`, where only `kill` gets it out.

A result can also fail to record: `RunsService.record` throws on all 3 tries of a
`run_finished` job. pg-boss then copies the job to the `run_finished_failed` dead letter queue,
whose worker calls `RunsService.recordFailedResult`. It writes the run's row without its diff
and applies `fail`, unless the run is no longer current. The daemon sends each result with the
run id as its pg-boss job id, so `recordLost` finds a queued result by id.

The run outcome events (`patch_ready`, `ops_fixed`, `escalate`, `fail`) carry the `runId` of
the job they report on, and only `RunsService` applies them. An event for any run other than
the current one is refused, so a retried `escalate` cannot skip a tier. A repeat report with
the same `fingerprint` bumps `occurrences` on the open issue; after a terminal status it opens
a new one.

## API

| Method | Path                  | Body                                       |
| ------ | --------------------- | ------------------------------------------ |
| GET    | `/health`             |                                            |
| POST   | `/issues`             | `{ fingerprint, title }`                   |
| GET    | `/issues?status=`     |                                            |
| GET    | `/issues/:id`         |                                            |
| GET    | `/issues/:id/events`  |                                            |
| POST   | `/issues/:id/events`  | an `issueEvent`, e.g. `{ "type": "kill" }` |
| GET    | `/issues/:id/runs`    |                                            |
| GET    | `/nodes`              |                                            |
| GET    | `/nodes/:name/runs`   | `?limit=` 1 to 100, default 20             |
| GET    | `/approvals?issueId=` | or `?runId=`; below                        |
| POST   | `/ingest/posthog`     | a PostHog `$exception` webhook             |
| GET    | `/` and `/assets/*`   | the built UI, below                        |

Every route but `/health` and `/ingest/posthog` needs `Authorization: Bearer
<ORCHESTRATOR_API_TOKEN>` and returns 401 without it. With the token unset they all return 401,
and boot logs a warning, so a service without it is closed rather than open. `/health` stays
open for Railway's health check, and `/ingest/posthog` checks `POSTHOG_WEBHOOK_SECRET` instead.
`POST /issues` has no rate limit: only token holders reach it, and a repeat report with the same
fingerprint bumps `occurrences` instead of adding a row.

Bodies are validated against the zod contracts (400). `POST /issues/:id/events` also returns
400 for `patch_ready`, `ops_fixed`, `escalate` and `fail`: run outcomes reach an issue only
through the `run_finished` queue, which also writes the `runs` and `escalations` rows. Unknown ids return 404. Events the current status doesn't allow return 409. `GET /issues`
returns at most 200 issues, most recently updated first; a repeat report counts as an update.

`GET /nodes` and `GET /nodes/:name/runs` serve the UI's agents pages (`nodeSummarySchema` and
`nodeRunSchema` in contracts). `/nodes` lists each node daemon by name: the ones connected to
this instance, the ones it saw leave, and the 50 that worked the newest runs, each with the
runs it holds now (issue title, tier, status, step count and last step) and when it took its
newest. `/nodes/:name/runs` lists the runs a daemon worked, the one it took last first,
including the one in progress. A name a daemon can't have returns 400, and a name no daemon
used returns an empty list.

## UI

The orchestrator serves the built dashboard (`apps/ui/dist`, from `UI_DIST_DIR`) on the same
origin as the API and the socket, so the UI needs no CORS and no API URL. `src/static/serve-ui.ts`
registers one route per file in the build, cached for a year since Vite hashes their names.
Any other GET a browser makes for a page (HTML acceptable, no file extension) gets
`index.html` uncached, so a reload on `/incidents/:id` works. Every API route above is matched
before that fallback, and a request that isn't for a page (curl, `fetch`, a missing asset)
still gets the JSON 404. The files need no token; the API and the socket do.
With no `index.html` in `UI_DIST_DIR`, boot logs a warning and only the API is served.

## Live events

`UiGateway` serves Socket.IO on the HTTP port, under `/socket.io/`, in the `/ui` namespace
(`UI_NAMESPACE` in `@page/contracts`). The handshake sends the API token as `auth.token`, since
a browser can't set headers on a WebSocket. Without it, or with a wrong one, the connection is
refused with `connect_error` `unauthorized`. Each connected tab gets `issue.updated` (`{ v: 1,
issue }`, `serverToUiEvents` in contracts) whenever an issue is opened, repeated or moved,
whether by ingest, triage, an API event or a run result. The payload is checked against its
contract before it goes out. IssuesService publishes the issue after the transaction commits
(`report`, and `afterCommit` for every status change), so a rolled-back change is never sent.
Events go only to tabs on the instance that made the change, which is fine with one instance.

Node daemons connect to the `/node` namespace (`NODE_NAMESPACE`) with `NODE_SHARED_SECRET` as
`auth.token`, and are refused with `unauthorized` without it (`NodeGateway`). Each event a
daemon or a tab sends is checked against its contract (`nodeToServerEvents`,
`uiToServerEvents`), and one that fails is logged and dropped.

- **Relay.** `node.step` goes to every tab as `run.step`, `node.diff` as `run.diff` and
  `node.run.finished` as `run.finished`, in the order the daemon sent them. The first step of
  the issue's run in progress (seq 0) also sends `run.started`: from that step on,
  `GET /issues/:id/runs` calls the run `running`. None of it is stored here: the daemon writes
  the `steps` table itself, and the `run_finished` job stays the record of a run. A tab doesn't
  get what was sent while it was disconnected, so it should load the runs again on reconnect.
- **Names.** A daemon sends its name (`NODE_NAME`, or its hostname) as `auth.name` in the
  handshake. One that sends none, or one a hostname can't hold, is listed as
  `unnamed-<address>` and logged. Sockets with the same name count as one daemon. On a
  daemon's first event for a run, the gateway writes the `run_nodes` row that says which
  daemon worked it, since the pg-boss claim doesn't say. Every tab gets `node.updated`, the
  daemon as `GET /nodes` lists it, when a daemon connects, disconnects, takes a run or lets
  one go, after the run's own event.
- **Which daemon holds a run.** The claim is the pg-boss `fix` job, which doesn't say which
  daemon took it. `Nodes` keeps, in memory, the socket whose events last named each run: from
  its first event for the run until its `node.run.finished` or its disconnect. After a
  restart a daemon holds its runs again from its next event.
- **Kill.** Every committed change that cancels a run's fix job sends `run.kill` to the daemon
  holding that run, and to no other (`RunKills`). That covers the issue `kill` event, the UI's
  `run.kill` (which kills the issue whose run is in progress, as the event does), and a run
  failed after its job expired. A kill for a run no daemon holds still kills the issue and
  cancels the job. On a daemon's first event for a run that is no longer its issue's run in
  progress and has no recorded result, such as one killed before its first step or while the
  daemon was away, the gateway sends that daemon `run.kill`. The daemon stops the run and
  reports it `killed`.

Each gateway has a handler map, and an event with no handler is logged and dropped. `run.chat`
waits for a daemon that handles it.

## Tier 3 approvals

A Tier 3 run asks a person before each gated ops call: `ops.setConfig`, `ops.deleteConfig`,
`ops.restart` and `ops.rollback` (`APPROVAL_TOOLS` in `@page/toolkit`; `apps/node/README.md`
says why those four). `ApprovalsModule` holds the requests and their decisions in the
`approvals` table, and `ApprovalRelay` in the gateway sends each change out.

- **Request.** The daemon sends `node.approval.request` with an id it picked, the run, the
  tool, its arguments, `expiresAt`, when it stops waiting, and `reason`, the agent's own words
  for why (at most 1,000 characters; `approvals.reason`, `011_approval_reason.sql`). The server
  runs the reason through `approvalReason` again and stores null for a daemon that sends none.
  `ApprovalsService.request` stores it pending under the issue whose run it is, holding
  `expiresAt` to `MAX_APPROVAL_WAIT_MS` (15 minutes), and every tab gets
  `approval.requested`. A request from a run that is no longer its issue's run in progress is
  stored rejected and answered at once. One for a run no issue knows is dropped.
- **Decision.** A tab sends `approval.decide` with the id and `approved` or `rejected`. The
  server records it as `ui:<name>` (identity, below), every tab gets `approval.updated`, and
  the daemon holding the run gets `approval.decided`. The update is conditional on the row
  being pending and before `expires_at`, so the first decision wins. A second one is refused
  and logged, and the tab that sent it gets `approval.updated` with the decision that stands.
- **The server closes a request** as rejected when no one decides by `expires_at`
  (`system:timed_out`), and when its run stops waiting (`system:run_ended`): on
  `node.run.finished`, on a change that cancels the run's fix job (a kill, the next tier),
  and when the issue leaves `fixing`. Each close reaches the tabs and the daemon like a
  person's decision. Deadlines are timers on the instance that stored the request, set again
  at boot for every request still pending, and a decision after `expires_at` is refused
  whatever the timers did.
- **A daemon that was away** gets nothing sent meanwhile, so after a reconnect it sends each
  request still waiting again, with the same id. The server stores nothing new: it answers
  one decided meanwhile with its decision, and keeps waiting on one still open.

`approvals.run_id` is the fix job's id, as `steps.run_id` is, with no foreign key: a run in
progress has no `runs` row until its result is recorded, and that is when it asks. Each
request names its issue instead (`issue_id`, a foreign key), so an issue with approvals can't
be deleted (`009_approvals_in_progress.sql`). Creating the `runs` row when a run starts would
have kept the key, but `GET /issues/:id/runs`, `RunsService.owner` (which tells a recorded run
from one in progress) and `recordLost` all read a row as a finished run.

`GET /approvals?issueId=<id>` lists an issue's approvals, oldest first, pending and decided,
and `?runId=<id>` a run's. A tab loads them when it opens an incident and after each reconnect,
since it misses what was sent while it was away. Without exactly one of the two it answers 400,
and 404 for an unknown issue.

**Identity.** Every tab shares `ORCHESTRATOR_API_TOKEN`, so the token says nothing about who
is there. A tab that decides also sends the person's name as `auth.name` in its handshake
(`approverNameSchema`: 1 to 40 letters, digits, spaces or `.'_-`), and the server keeps
`ui:<name>` on the socket. `approval.decide` carries no decider, and the server takes it from
the socket, never from the payload; a tab with no name, or one that isn't allowed, can't
decide. The name is what the person typed, not a login: it tells honest teammates apart in the
record, and anyone with the token can connect under any name. The server's own decisions are
`system:timed_out` and `system:run_ended`, which no name can match since a name has no colon.

## Rate limits

The routes and the sockets added for the UI and the node daemons are limited per client, in
memory (`src/rate-limit.ts`), so each instance counts its own and a restart starts over:

| What                                | Limit         | Past it                                     |
| ----------------------------------- | ------------- | ------------------------------------------- |
| UI files, per address               | 300 a minute  | 429 with `Retry-After`                      |
| UI socket handshakes, per address   | 30 a minute   | Refused with `connect_error` `rate_limited` |
| UI socket messages, per socket      | 20 every 10s  | The socket is closed                        |
| Node socket handshakes, per address | 30 a minute   | Refused with `connect_error` `rate_limited` |
| Node socket messages, per socket    | 300 every 10s | The socket is closed                        |
| `/nodes` routes, per address        | 60 a minute   | 429 with `Retry-After`                      |

A page load is index.html and about ten hashed files, so 300 a minute is about 30 full reloads.
A tab handshakes once and socket.io-client retries a lost connection at most every 5s, under
12 a minute, so 30 leaves room for a few tabs behind one address. The handshake limit runs
before the token check, so it also holds a token guesser to 30 tries a minute. Kill, chat and
approval decisions are clicks, far under 20 in 10s; `approval.decide` counts toward that
limit like every other message, so a tab that floods decisions is closed. A daemon's
approval requests count toward its 300, at most one per gated call. A daemon handshakes once, and after a
refusal it waits a minute, so 30 leaves room for several daemons behind one address and holds
a secret guesser to 30 tries. A run sends a step per command, each after a model call, so
well under one a second; 300 in 10s leaves room for the events a daemon buffered while it was
disconnected, which it sends at once. A daemon whose socket is closed connects again 5s later,
and its steps are in the `steps` table either way. A tab loads `/nodes` when it connects or
reconnects, and an agent's runs again when that daemon takes or lets go of a run, so a few a
minute; 60 leaves room for several tabs behind one address. The two `/nodes` routes share
one count, which runs after the token check (`RateLimitGuard`), so a request without the
token gets its 401 and isn't counted. API routes don't count toward the UI's limit. The address is the last `X-Forwarded-For` entry,
which Railway's proxy adds, or the socket's own address. Without a proxy in front a client can
set that header itself, so the limits slow a misbehaving client; the token is what keeps
strangers out.

## Run locally

```sh
pnpm db:up                                  # repo root, starts Postgres
cp .env.example .env                        # repo root, if you haven't
pnpm --filter @page/ui build                # optional: the UI served on :4000
pnpm --filter @page/orchestrator dev        # builds, migrates, listens on :4000
```

Migrations in `migrations/` run on boot under an advisory lock. pg-boss installs its own
tables in the `pgboss` schema (`PGBOSS_SCHEMA`). `PORT` and `HOST` are also read from the
environment.

Nest needs legacy decorators with emitted metadata, which Node's type stripping can't run,
so the app is compiled with `tsc` to `dist/` rather than run from source.

## Configuration

`src/config.ts` reads these once at boot:

| Variable                      | Default                 | Notes                                                                         |
| ----------------------------- | ----------------------- | ----------------------------------------------------------------------------- |
| `DATABASE_URL`                |                         | Required; a `postgres://` or `postgresql://` URL                              |
| `PORT`                        | `4000`                  | Railway sets it                                                               |
| `HOST`                        | `0.0.0.0`               |                                                                               |
| `PGBOSS_SCHEMA`               | `pgboss`                | Must match the node daemon's                                                  |
| `USE_FAKE_ADAPTERS`           | `false`                 | `true`/`1`/`yes`/`on` or `false`/`0`/`no`/`off`                               |
| `LOG_LEVEL`                   | `info`                  | `fatal`, `error`, `warn`, `info`, `debug`, `trace`                            |
| `NODE_SHARED_SECRET`          |                         | What a node daemon sends as `auth.token` on `/node`. Unset refuses every one  |
| `POSTHOG_WEBHOOK_SECRET`      |                         | Bearer secret for `POST /ingest/posthog`. Unset rejects every webhook         |
| `OPENROUTER_API_KEY`          |                         | Unset, or `USE_FAKE_ADAPTERS`, uses the rule fallback                         |
| `TRIAGE_MODEL`                | `openai/gpt-4o-mini`    | Cheap model for triage                                                        |
| `TRIAGE_TIMEOUT_MS`           | `8000`                  |                                                                               |
| `AUTO_START_FIX`              | `false`                 | Triage sends `start_fix` after classifying, queueing the Tier 1 fix job       |
| `AUTO_START_FIX_MAX_PER_HOUR` | `5`                     | Fix starts in the last hour past which triage leaves issues for an operator   |
| `TWILIO_ACCOUNT_SID`          |                         | Set together with the token and from-number                                   |
| `TWILIO_AUTH_TOKEN`           |                         |                                                                               |
| `TWILIO_FROM_NUMBER`          |                         |                                                                               |
| `TWILIO_MACHINE_DETECTION`    | `false`                 | Voicemail or fax counts as not answered. Paid accounts only: trial rejects it |
| `TWILIO_TRIAL`                | `false`                 | Trial account: calls and texts use Twilio's templates, not the page text      |
| `NOTIFY_TO_NUMBERS`           |                         | Comma-separated E.164 numbers                                                 |
| `DASHBOARD_URL`               | `http://localhost:4000` | Where the UI is served; the call and SMS link `<url>/incidents/<id>`          |
| `UI_DIST_DIR`                 | `../ui/dist`            | The built UI, relative to the working directory (`apps/orchestrator`)         |

A missing or bad `DATABASE_URL` stops startup with exit code 1 and one log line naming each
problem, e.g. `invalid config: DATABASE_URL is required`. As in `apps/node`, a blank var
counts as unset, so a copied `.env.example` boots. `USE_FAKE_ADAPTERS` skips OpenRouter and
Twilio. With it off, a missing key still boots: triage uses the rules and pages are recorded
instead of sent. The three Twilio vars are set together or not at all. Account setup, trial
limits and the `page:test` check that pages every phone are in
[docs/twilio.md](../../docs/twilio.md).

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
