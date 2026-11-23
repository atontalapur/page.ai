# page.ai

[![CI](https://github.com/atontalapur/page.ai/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/atontalapur/page.ai/actions/workflows/ci.yml)

[![Node.js 24](https://img.shields.io/badge/Node.js-24-5FA04E?logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![pnpm 12](https://img.shields.io/badge/pnpm-12-F69220?logo=pnpm&logoColor=white)](https://pnpm.io)
[![TypeScript 6](https://img.shields.io/badge/TypeScript-6-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Next.js 16](https://img.shields.io/badge/Next.js-16-000000?logo=nextdotjs&logoColor=white)](https://nextjs.org)
[![NestJS 12](https://img.shields.io/badge/NestJS-12-E0234E?logo=nestjs&logoColor=white)](https://nestjs.com)
[![PostgreSQL 18](https://img.shields.io/badge/PostgreSQL-18-4169E1?logo=postgresql&logoColor=white)](https://www.postgresql.org)
[![Vitest 5](https://img.shields.io/badge/Vitest-5-6E9F18?logo=vitest&logoColor=white)](https://vitest.dev)

[Problem](#problem-and-background) · [How it works](#how-it-works) · [Status](#status) · [Results](#results) · [Getting started](#getting-started) · [Repository layout](#repository-layout) · [Docs](#docs) · [Project plan](#project-plan) · [Team](#team)

PageAgents takes first response to production errors off the on-call engineer. When an error
reaches PostHog, the orchestrator triages it, pages on-call, and hands the error report to a
coding agent that works in a sandbox with no network. The agent starts at Tier 1 with the least
access and climbs a tier when it runs out of steps, money or time. Past Tier 3, a human takes
over.

## Problem and background

On-call engineers get paged for routine errors (a null check, a bad config value, a failing
third-party call), and each one costs a context switch, log digging and a patch. PostHog
captures the exception and its context but stops at alerting, while coding agents can now write
patches that pass tests. PageAgents turns the error report into the agent's task, limited by
what each tier can safely touch.

## How it works

```
demo app --errors--> PostHog --webhook--> orchestrator --call + SMS--> on-call (Twilio)
                                            |      ^
                                    fix job |      | run_finished
                                  (pg-boss) v      |
                                         node daemon --> sandbox container (agent)
                                            |
                                            +--> PR on the demo repo (Tier 2+)
                                            +--> demo app ops API (Tier 3)
                                            +--> demo app rollback on Railway (Tier 3)
```

1. Ingest. The demo app reports unhandled errors to PostHog Error Tracking, and a PostHog
   webhook posts each `$exception` event to `POST /ingest/posthog` on the orchestrator. Repeats
   group by fingerprint. The stored report keeps the request line, the exception and its in-app
   frames, and drops bodies, headers, cookies, query values and email addresses, since a Tier 2
   run puts it in a public PR.
2. Triage. A cheap OpenRouter model reads the stored report and sets the class (frontend,
   backend/API, database or infra/config) and the severity. Rules over the same report take
   over when the model times out or replies with junk, and their severity is a floor under
   the model's. The orchestrator then calls and texts on-call through Twilio with a dashboard
   link.
3. Fix. With `AUTO_START_FIX=true`, triage queues a Tier 1 fix job, at most
   `AUTO_START_FIX_MAX_PER_HOUR` (default 5) an hour. The node daemon claims it, starts a
   sandbox container and runs the agent, a TypeScript port of
   [mini-swe-agent](https://github.com/SWE-agent/mini-swe-agent), on the report.
4. Escalate. Each tier gets 40 model calls, $0.50 and 14 minutes
   ([`threshold.ts`](packages/agent/src/threshold.ts)). A run that hits a limit before it
   submits a patch moves the issue up a tier. Past Tier 3 the issue fails and stays with a
   human. A submitted patch puts the issue in `awaiting_approval`. A Tier 3 run that fixes
   the live app through its ops API or a rollback and changes no code resolves the issue,
   since the fix is live already and there is no patch to approve.
5. Audit. Every agent command goes through `execute()` in `@page/toolkit`, which parses it,
   checks it against the tier's rules and writes a `steps` row before it runs. A command whose
   step can't be written doesn't run.

| Tier | What the agent can do                                                                                                         |
| ---- | ----------------------------------------------------------------------------------------------------------------------------- |
| 1    | Read, search, edit and test the code in the sandbox through an allowlist of shell commands                                    |
| 2    | Tier 1, plus push a `pageagents/<runId>` branch and open a PR on the demo repo, [`atontalapur/page-demo`](docs/demo-repo.md)  |
| 3    | Tier 2, plus read and change the live demo app's runtime config, restart it (at most 3 times) and roll back its deploy (once) |

At every tier the toolkit blocks `sudo`, `curl`, `wget`, `docker`, force pushes, shell
expansion and subshells, and writes outside the repo or under `.git/`, `.github/` or
`node_modules/`. The sandbox has no network, 1 CPU and 1 GB of memory, and is killed after 15
minutes ([ADR 0001](docs/adr/0001-sandbox-network-policy.md)).

## Status

Working and tested: ingest, triage, paging, the issue state machine and its queues; the node
daemon, sandbox, toolkit and the Tier 2 and Tier 3 host tools; 30 seeded bugs with a self-test
in CI; the eval runner, its report and charts, a nightly eval and an end-to-end harness. A
staging run on Railway took scenario 029 from a 500 on the demo app through PostHog to a
triaged issue in 3 seconds.

Not built yet:

- Confidence scoring. Runs escalate only on the step, cost and time limits, and a submitted run
  reports `confidence: null`.
- The dashboard. `apps/ui` renders placeholder data and doesn't read the orchestrator.
- `ApprovalsModule` is a stub, and `GatewayModule` serves the UI but not the node daemons, so a
  kill can't stop a run a daemon has already claimed.

## Results

All runs used `deepseek/deepseek-v4.1-flash` under three configurations: `tier1-only`,
`tier3-start`, and `ladder` (Tier 1, then 2, then 3). The held-out set was run once, after the
escalation threshold was frozen, as the [preregistration](docs/report/eval-prereg.md) requires.

| Set                              | Runs | Cost  | tier1-only | tier3-start | ladder |
| -------------------------------- | ---- | ----- | ---------- | ----------- | ------ |
| Dev, 18 code bugs x 3 runs       | 162  | $1.28 | 51/54      | 51/54       | 51/54  |
| Held-out, 9 code bugs x 1 run    | 27   | $0.19 | 9/9        | 8/9         | 9/9    |
| Ops, 2 live-config bugs x 3 runs | 18   | $0.62 | 0/6        | 5/6         | 3/6    |

The preregistered bars pass on dev and held-out. On dev, the ladder twice submitted a wrong
patch at Tier 1 (bugs 013 and 014) and never escalated or paged. On the ops set the ladder
missed 029 every time: a lower tier submitted a code patch that left the live app broken, so it
never reached the Tier 3 tools. Tables, charts and the threats to validity are in
[evaluation-method.md](docs/report/evaluation-method.md#results).

## Getting started

You need Node 24, pnpm 12 (`corepack enable` picks up the pinned version) and Docker.

```sh
pnpm install
cp .env.example .env    # or `pnpm env:pull` for the team's shared secrets (docs/env-sync.md)
pnpm db:up              # Postgres 18 on :5432
```

Set `ORCHESTRATOR_API_TOKEN` in `.env`; with it blank, every orchestrator route except
`/health` and `/ingest/posthog` returns 401. To run without Docker sandboxes, a model key,
GitHub or Twilio, set `USE_FAKE_ADAPTERS=true`. Then start the pieces in separate terminals:

```sh
docker build -f infra/sandbox/Dockerfile -t page-sandbox .   # not needed with fake adapters
pnpm --filter @page/orchestrator dev    # API on :4000, runs migrations on boot
pnpm --filter @page/node start          # daemon that claims fix jobs
docker compose up demo-app              # demo shop on :3000
pnpm --filter @page/ui dev              # dashboard
```

Checks, as CI runs them:

```sh
pnpm format:check
pnpm lint               # ESLint in every package, plus dependency-cruiser
pnpm typecheck
pnpm test               # unit tests; Postgres-backed ones use PGlite, so no database needed
pnpm test:integration   # needs DATABASE_URL, from `pnpm db:up`
pnpm scenarios:selftest page-sandbox 001-bad-currency-code   # clean, broken and fixed checks
```

Running the eval and the end-to-end test is covered in [eval/README.md](eval/README.md).
Commits follow Conventional Commits, and commitlint checks them and PR titles.

## Repository layout

| Path                     | What it is                                                                                     |
| ------------------------ | ---------------------------------------------------------------------------------------------- |
| `apps/orchestrator`      | NestJS (Fastify) service: ingest, triage, paging, issue state machine, pg-boss queues          |
| `apps/node`              | Daemon that claims fix jobs, runs the agent and one sandbox container per run                  |
| `apps/demo-app`          | Next.js and Postgres shop that the seeded bugs break; plays production                         |
| `apps/ui`                | Vite and React dashboard (placeholder data for now)                                            |
| `packages/agent`         | The agent loop, its prompts and the per-tier escalation threshold                              |
| `packages/toolkit`       | `execute()`, the tier policy, the audit log, and the GitHub and ops host tools                 |
| `packages/model-client`  | OpenRouter client used by the agent and triage                                                 |
| `packages/contracts`     | zod schemas shared between apps: jobs, events, config, scenario metadata                       |
| `packages/db-migrations` | The orchestrator's SQL migrations                                                              |
| `packages/design-system` | shadcn/ui components themed with Radix Colors                                                  |
| `packages/config`        | Shared tsconfig, ESLint and Prettier presets                                                   |
| `scenarios`              | The 30 seeded bugs: `break.sh`, `trigger.sh`, `check.sh`, a reference fix and `meta.json`      |
| `eval`                   | Scenario self-test, eval runner, report and chart scripts, end-to-end harness, results         |
| `infra`                  | Sandbox image, a seeded demo image, and a single image that runs the orchestrator and demo app |
| `docs`                   | Setup guides, ADRs and the final report draft                                                  |

## Docs

- Per-app guides: [orchestrator](apps/orchestrator/README.md), [node daemon](apps/node/README.md),
  [demo app](apps/demo-app/README.md), [scenarios](scenarios/README.md), [eval](eval/README.md),
  [infra](infra/README.md)
- Setup: [shared env](docs/env-sync.md), [PostHog](docs/posthog.md), [Twilio](docs/twilio.md),
  [demo repo for agent PRs](docs/demo-repo.md)
- Decisions: [ADRs](docs/adr/) on the sandbox network policy, Kysely with plain SQL migrations,
  and pg-boss over Redis
- Report: [final report draft](docs/report/README.md) and [contributions](docs/contributions.md)

## Project plan

The plan from the proposal. The budget is $95 for the quarter; the three eval runs above cost
$2.09 of the OpenRouter share.

| Item                    | Budget | Use                                         |
| ----------------------- | ------ | ------------------------------------------- |
| OpenRouter              | $60    | Agent and triage calls                      |
| Railway                 | $15    | Orchestrator, demo app and Postgres staging |
| Twilio                  | $10    | Calls and SMS to on-call                    |
| PostHog, GitHub, Docker | $0     | Error tracking, repos, CI, sandboxes        |
| Buffer                  | $10    | Evaluation overruns                         |

| Week | Milestone                                                                                           |
| ---- | --------------------------------------------------------------------------------------------------- |
| 5    | Demo app, PostHog webhook, error-tracking agent with Twilio, CLI allowlist wrapper                  |
| 6    | Orchestrator, Tier 1 and 2 agents, confidence scoring and escalation; dashboard live view and diffs |
| 7    | Dashboard approval, query and kill; Tier 3 agents; end-to-end integration                           |
| 8    | Evaluation on 30 bugs: fix rate per tier, time to fix, false escalations                            |
| 9    | Final demo and report                                                                               |

## Team

- Daniyal: dashboard lead; demo and report
- Nidheesh: ingest pipeline, error-tracking agent, PostHog
- Arjun: orchestrator, tiering, escalation logic, Twilio
- Advaith: CLI toolkits, sandboxing, demo app and evaluation, PostHog

## License

[MIT](LICENSE)
