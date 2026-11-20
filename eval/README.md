# eval

Scenario self-test (#6) and, later, the eval runner and results for the 30-bug
evaluation (#15, #16). See [scenarios/README.md](../scenarios/README.md) for the scenario
format.

- `src/scenario.ts` loads a scenario directory and validates its `meta.json`.
- `src/selftest.ts` runs the clean / broken / fixed check: in a sandbox for a code
  scenario (Tier 1 and 2), and on the host against a live demo app for an ops scenario
  (Tier 3).
- `scripts/selftest.ts` is the CLI behind `pnpm scenarios:selftest`. Ops scenarios need
  `DEMO_APP_URL` and `OPS_SECRET`; without them they are skipped when no ids are named,
  and fail when they are. `--concurrency N` (or `SELFTEST_CONCURRENCY`) runs up to N code
  scenarios at once, each in its own sandbox; ops scenarios stay one at a time.
- `split.json` is the dev / held-out split for the evaluation (#16): 20 dev, 10 held
  out, even by class. It was committed before any tuning. Tuning looks only at the dev
  set; the held-out bugs run once, after the escalation threshold is frozen.
  `src/split.test.ts` checks that every scenario is in one set and that the file equals
  what `deriveSplit` gives for the seed, so nobody hand-picked them. The three ops
  scenarios (024, 029, 030) are in the split. The runner plays them only against a live
  demo app (below) and lists them as skipped without one.

## Eval runner (#15)

```sh
docker build -f infra/sandbox/Dockerfile -t page-sandbox .
pnpm eval:run page-sandbox --config ladder --set dev --runs 3 --max-cost 5 --concurrency 3
```

- `--config` picks the tiers a run climbs: `tier1-only`, `tier3-start` or `ladder`
  (Tier 1, then 2, then 3). A run moves up a tier only when the agent runs out of
  steps, budget or time, as the daemon escalates an issue. Any other exit (model,
  format or audit failure) pages a human at that tier.
- Every attempt starts a fresh sandbox and runs `break.sh`, then starts the repo over so
  the broken code is its only commit, as a production bug already in `HEAD` would be.
  The agent gets the scenario's `report`. Its diff (everything since that commit,
  including new files and its own commits) is then checked in a second fresh sandbox:
  `break.sh`, the diff, `check.sh`. The check never enters the agent's sandbox and isn't
  squeezed into the last seconds of its wall clock. It runs on every outcome, so a tier
  that escalated a patch that already passed counts as a false escalation, and a run
  that paged with a passing patch as a false page. Whether to climb depends only on how
  the agent stopped, so the check runs alongside the later tiers, and a ladder run can
  have three sandboxes up at once. A check that fails drops the run: the tier playing
  is stopped (charged what it spent so far) and no tier starts after it. A dropped run's
  other checks are stopped too.
- `--concurrency N` plays up to N scenario runs at once (default 1), each climbing its
  tiers in order. Results stay in the planned order. Every attempt in flight holds its
  tier's full cost limit (`ESCALATION_THRESHOLD` in `packages/agent/src/threshold.ts`,
  $0.50 at every tier today), so `--max-cost` has to cover N of those for N agents to
  run together; on less, runs wait for money. Once a paid model has spent past that
  margin, fewer than N play at once. `eval:run` warns at startup
  in both cases. Sandboxes share the host's CPUs, so
  durations and `time_limit` exits at different concurrency aren't strictly comparable.
  OpenRouter caps `:free` models at 20 requests a minute per key, and `withRetries`
  gives up on a 429 after about 3 seconds, which stops the eval. One agent on
  nemotron-3-ultra makes about 3 to 7 calls a minute, so keep N at 2 or less on a free
  model.
- From Tier 2 the agent's push and PR go to an in-memory GitHub, never the demo repo.
- `--max-cost` is the total budget. Each attempt reserves its tier's cost limit before it
  starts and gives back what it didn't spend, so the attempts in flight never hold more
  than is left. Less than the full limit goes out only when no other attempt is in
  flight, and no attempt starts with less than $0.05. A run the budget cut short, at any
  tier, is dropped and flagged with `stoppedForBudget`, and no attempt starts after it.
  At `--concurrency` above 1, runs in flight then finish only if they don't need another
  tier, so the runs kept near the cutoff lean toward easy ones and needn't be the first
  ones planned.
  The agent checks its limit before each model call, so the total can go over by one
  call's cost per attempt in flight: one call at `--concurrency 1`, as before. `spentUsd` is
  everything charged against the budget, dropped runs and errors included;
  `summary.costUsd` counts only the runs kept.
- A run whose agent ends on a model error (a rate limit or used-up quota, auth, credits, a
  provider outage or a malformed reply, after `withRetries` gave up) is not a page. The
  attempt goes in `errors`, its run is left out, and the eval stops with
  `stoppedForProvider`, since the next attempt would hit the same wall: no attempt starts
  after it, in that run or any other, and attempts and checks in flight are stopped.
- After a budget or provider stop, `notPlayed` lists the planned runs it left out with
  no error: never started, or cut short mid-climb. Those and the runs in `errors` are
  what to rerun; at `--concurrency` above 1 they needn't be the last ones planned.
- The results file is rewritten after every run, so a long eval can pause. Ctrl-C stops
  the attempts in flight and writes the file; their runs go in `notPlayed`. Later,
  `pnpm eval:run page-sandbox --resume <file> --set dev` keeps the file's runs and spend,
  plays the rest (runs in `errors` and `notPlayed` included) and rewrites the same file.
  `--config`, `--model` and `--runs` default to the file's, and the commit has to match,
  so check out the file's `gitSha` first if `main` moved. `--max-cost` is the total, the
  earlier spend included. Don't let the laptop sleep mid-run: pause first.
- Ops scenarios (Tier 3) break a live demo app, not the sandbox, so they need one: set
  `DEMO_APP_URL` and `OPS_SECRET` (for example `docker compose up demo-app` with
  `OPS_SECRET` set). Without them they are skipped with a reason. Leave `POSTHOG_KEY`
  unset on that app: its errors would go through the PostHog webhook to the staging
  orchestrator, which opens an issue and pages the on-call phones. Before each run the
  runner drops every runtime config override on the app, restarts it and runs
  `break-ops.sh`. Tier 3 attempts get the ops tools on that app (`page_ops_*` blocks);
  code scenarios at Tier 3 get them on an in-memory fake. `check.sh` runs on the host as
  soon as the agent stops, before the next tier can change the app. Ops runs take turns
  on the app (code runs don't wait), one eval process at a time may hold it, and the
  eval resets it when it ends. 024 needs a rollback, which has no agent tool yet.
- An attempt that throws (a sandbox or `break.sh` failure) goes in `errors` and its run
  is left out; the eval goes on. If it failed after the agent ran (the diff or the check
  sandbox), the agent's real cost counts against the budget; otherwise its spend is
  unknown and its whole limit counts.
- Results go to `eval/results/<start>-<config>.json` (`src/results.ts` has the schema):
  per run the tiers tried, tier landed, fixed, paged, time to fix or page, cost, steps
  and blocked steps, and the agent's diff; plus a summary.
- `.github/workflows/eval-nightly.yml` runs the first 10 dev scenarios under `ladder`
  every night at 2 a.m. Pacific, with a $1 budget, and commits the results to the
  `eval/nightly-results` branch. It needs the `OPENROUTER_API_KEY` secret and the
  `OPENROUTER_MODEL` repository variable.
- `pnpm eval:report <results.json>...` prints the report's Results tables as markdown
  from one results file per config: the preregistered bars, fix rate overall, per class
  and per tier, cost per fixed bug, time to fix and page (p50, p90), unsafe attempts per
  100 steps by tier, and the bugs where the ladder fixed fewer runs than `tier3-start`.
  It refuses two files for one config, files from different models and files that
  planned different scenarios (dev next to held-out), and flags results left incomplete
  by a budget or provider stop, errors, unplayed runs or skipped scenarios. The ladder
  bar and the shortfall table compare fix rates only on bugs both configs played.

## Tuning the escalation threshold (#114)

```sh
pnpm eval:tune eval/results/<dev-run>-*.json
```

- `eval:tune` prints, per tier, tables for picking `ESCALATION_THRESHOLD` in
  `packages/agent/src/threshold.ts`, pooled over every attempt at that tier in the files:
  attempts, submissions, fixes (submitted and passed `check.sh`), step, cost and time
  limit hits, and false escalations (a limit hit whose patch still passed); p50, p90 and
  max model calls, cost and duration of the fixes; and what-if tables showing how many
  fixes a lower step, cost or time limit would have cut.
- It reads dev results only. It loads `split.json` and refuses, printing nothing, if any
  file names a scenario outside the dev set in `runs`, `errors`, `notPlayed` or
  `skipped`. The error names the file and the scenario.
- Runs were cut at the current limits, so the data can't say what a higher limit would
  do. The what-if tables list only candidates at or below the current value. A fix counts
  as cut when it used more than the candidate: exact for model calls and time, an upper
  bound for cost, since the agent checks spend before each call and the last call can
  cross the limit.
- `eval:run` records the per-tier limits a run played at in the results (`limits`), and
  `--resume` refuses a file played at other limits, uncommitted `threshold.ts` edits
  included. `eval:tune` filters against the checkout's `ESCALATION_THRESHOLD` and warns
  when a file's recorded limits differ from it. For a file from before #114, which records
  none, it compares `threshold.ts` at the file's `gitSha` with the working tree. It
  refuses the same run passed twice (a copy, a symlink, or a checkpoint next to its
  resume), but pools two runs of one config (say a rerun after a provider stop).

## End-to-end test (#14)

```sh
pnpm e2e 001-bad-currency-code --target local
pnpm e2e 016-product-id-or-slug --target staging --expect approval --runs 3
```

`pnpm e2e` plays one scenario through the live pipeline: it seeds the bug, runs
`trigger.sh`, then waits on the orchestrator's database for each step and checks the end
state. It loads `.env` if there is one (`--env-file-if-exists`). It talks to real
PostHog, the orchestrator, the node daemon and GitHub, so the daemon has to be up with a
model key. `src/e2e.ts` has the steps, behind ports that the unit tests fake;
`src/e2e-adapters.ts` and `scripts/e2e-targets.ts` are the real adapters.

The orchestrator needs `AUTO_START_FIX=true`, or a run stops at `claim`: nothing else
applies `start_fix` after triage. Past `AUTO_START_FIX_MAX_PER_HOUR` fix starts in an hour
(5 by default) triage stops starting them, which looks the same at `claim`; the
orchestrator logs `auto-start cap reached`. Raise it for `--runs` above that. The daemon reports each run's end as a `run_finished` job,
which the orchestrator records (#136).

| Step      | Waits for                                                                          | Default limit         |
| --------- | ---------------------------------------------------------------------------------- | --------------------- |
| `seed`    | the bug live on the target (see below)                                             | 20m                   |
| `trigger` | `trigger.sh` to exit 0                                                             | 2m                    |
| `issue`   | an `issues` row opened after the trigger, titled like the report's error           | 5m                    |
| `triage`  | the issue to leave `new`                                                           | 2m                    |
| `claim`   | a fix run on the issue that a daemon picked up (pg-boss job, steps or row)         | 5m                    |
| `fix`     | the issue to wait on a human, following each tier of a ladder climb                | 16m per expected tier |
| `outcome` | an open PR from `pageagents/<runId>`, or `awaiting_approval` or a pending approval | 2m                    |
| `reset`   | the reset below                                                                    | 10m, plus the drain   |

Change a limit with `--timeout fix=20m`. A step that runs out names the last state it saw,
such as `issue triaged at tier -, no run (nothing sent start_fix after triage)`. The
orchestrator titles an issue with the whole exception, `<type>: <message>`, so the `issue`
step matches the title's first line against the report's error line (a ZodError is
`ZodError: [`). Any other issue seen meanwhile is ignored, and if none matches the step
runs out listing the titles it saw. A scenario that can't pass (no error line in its
report, or `--expect pr` without `GITHUB_TOKEN` and `GITHUB_REPO`) is refused before
seeding, so there is nothing to reset.

The `fix` and `outcome` steps also fail when the issue ends `failed`, `killed` or
`resolved`, and `fix` when the run's job has finished but the issue is still `fixing` a
minute later (its result never reached the orchestrator). Only a human's `approve`
resolves an issue (`apps/orchestrator/src/issues/transitions.ts`), so a resolved issue
means someone acted before the test saw the outcome, and it can't tell a PR from a patch
any more.

`--expect pr` waits for a PR; `--expect approval` for a human approval. The default is
`pr` for a Tier 2 code scenario and `approval` otherwise, since Tier 1 can't push and Tier
3 asks before an ops action. So with `--expect pr`, an issue that ends `awaiting_approval`
at Tier 1 fails `outcome` at once instead of waiting out its limit. The checks after the
outcome: the issue's status, its class and severity set, the run it ended on, at least one
`steps` row, a fix job that didn't fail, the `runs` row (when there is one) and its
`pr_url` matching the PR, and the time from the trigger to the outcome within `--budget`.
The default budget is the sum of the limits of the steps it covers, `trigger` through
`outcome`, so it follows `fix` up the tiers (32m at Tier 1, 48m at Tier 2, 64m at Tier 3)
and any `--timeout`; pass `--budget` for a tighter bar. A class or tier other than the
scenario's, and a missing `runs` row, are warnings.

The reset runs after every outcome, a failed step included: it kills the issue through
`POST /issues/:id/events`, which cancels its fix job and lets the next trigger open a new
issue, then closes any open PR from each of the issue's runs (every pg-boss `fix` job for
the issue and every `runs` row, not only the runs the test saw), and unseeds the target.
If the trigger ran but the test never picked up its issue (the `issue` step ran out, or
`trigger.sh` failed after sending), the reset looks once more for an issue opened since
the trigger with the report's title, and kills it and closes its PRs the same way.

The kill can't stop a run a daemon has already claimed: it only cancels the pg-boss job,
and the daemon stops on a `kill` the gateway relays, which is still a stub. So such a run
can open its PR after the close pass, and a Tier 3 run on a daemon with `OPS_APP_URL` can
still change and restart that app after the unseed. The reset prints a warning naming every run it saw
claimed and not finished, then watches each one's `pageagents/<runId>` branch, closing any
PR that opens, for what is left of the run's share of the `fix` limit (16m per tier by
default) since the test first saw it claimed. `--drain 5m` sets that window, and `--drain
0` skips the watch (the warning still prints). A PR still open when the window ends fails
the reset. A run waiting on a pending approval isn't watched, since nothing grants it after
the kill. The `reset` limit grows by the drain window.

A failed reset fails the run, since the next one would start dirty. `--keep` skips it, to
look at the PR or the issue; clean up by hand after. It only goes with one run: `--keep
--runs 3` is refused, since run 2 would find run 1's issue still open. Ctrl-C skips it
too. `--runs 3` plays the scenario three times and stops at the first failure, which is
the card's bar. Only dev bugs run, as with `demo-sync.sh`. The exit code is 0 when every
run passed, 1 when one failed and 2 for bad arguments, a malformed variable such as
`GITHUB_REPO` or `PGBOSS_SCHEMA` included. `--out <file>` writes the target's
one-time preparation (`prepare`, below) and every run's result as JSON.

### Targets

`--target local` (the default) runs the demo app on this machine; the orchestrator and
daemon can be the Railway ones or local ones.

- A code scenario builds `page-sandbox` and `page-sandbox:demo` with the scenario seeded
  once, before the first run and outside the `seed` step, so seed times compare across
  `--runs`. The build prints as `[prepare]` with its own time and goes in `--out` as
  `prepare`. It gets the `seed` limit (`--timeout seed=30m` for a cold cache), not the 10
  minutes a scenario script gets. `--no-build` reuses the images already built. Each seed
  then serves the demo app from that image with `next dev` in a container named
  `page-e2e-demo-app`, on `E2E_DEMO_APP_PORT` (default 3100, so the compose app keeps 3000).
  Dev mode because some bugs, 001 among them, throw while `next build` prerenders. The
  container migrates and seeds the `demo` database of the compose Postgres (`pnpm db:up`)
  first. If it exits before `/api/health` answers, the seed fails at once instead of
  waiting out its limit. After any failed seed, the summary shows the last 50 lines of the
  container's log, read before the unseed removes the container. Without `POSTHOG_KEY` the
  app keeps its errors in memory and no issue can open, so the run is refused before
  seeding.
- An ops scenario runs `break-ops.sh` and `fix-ops.sh` against the compose demo app at
  `E2E_LOCAL_APP_URL` (default `http://localhost:${DEMO_APP_PORT:-3000}`, where
  `docker-compose.yml` publishes it), started with `OPS_SECRET` set. It never reads
  `DEMO_APP_URL`, which is staging's, and refuses a URL whose host isn't `localhost`,
  `127.0.0.1` or `::1`, so a local run can't break a deployed app. The daemon's ops tools go
  to its own `OPS_APP_URL`, so for a local run leave it unset or point it at the compose
  app, never at staging.

`--target staging` runs against the deployed app at `DEMO_APP_URL`. The test never deploys,
so a code scenario's bug must already be live there: staging serves the seeded demo baseline
(`infra/sandbox/demo-sync.sh <id>`, `docs/demo-repo.md`). Seeding only waits for
`/api/health`, and since the reset closes the agent's PR, `main` keeps the bug for the next
run. An ops scenario runs `break-ops.sh` and `fix-ops.sh` there. A bad deploy (024) needs
the compose stand-in and is refused.

Railway's `demo-app` service builds page-demo `main`, so merging a `demo-sync.sh` PR deploys
the bug. The bug has to survive `next build`: 001 throws while prerendering, so staging can't
serve it. Staging is seeded with 016-product-id-or-slug. A live fix always starts at Tier 1
(`start_fix` in `apps/orchestrator/src/issues/transitions.ts`), and Tier 1 can't push, so a
bug that Tier 1 fixes ends on `awaiting_approval`. Pass `--expect approval` for it.

A staging run, step by step:

1. On the Railway orchestrator, set `AUTO_START_FIX=true`, and `AUTO_START_FIX_MAX_PER_HOUR`
   above `--runs`. Every pass opens a new issue, and every new issue pages on-call. To record
   the pages without sending them, unset `NOTIFY_TO_NUMBERS` and save its value first.
   Redeploy the orchestrator.
2. Add a TCP proxy to the `db` service. The daemon and the test both connect through it.
   Add `?sslmode=no-verify` to the URL: the Postgres template's certificate is self-signed,
   so the connection is encrypted but the server isn't verified.
3. Start the daemon on this machine with `DATABASE_URL` on the proxy, staging's
   `ORCHESTRATOR_URL` and `NODE_SHARED_SECRET`, and `SANDBOX_IMAGE=page-sandbox:demo` from
   the same `demo-sync.sh` run. For an ops scenario to reach Tier 3's ops tools, also set
   `OPS_APP_URL` to staging's app and `OPS_SECRET` to its secret; unset it again after. It logs `cannot reach the orchestrator` every few seconds,
   since the gateway is still a stub. Results go back through pg-boss either way.
4. Run the test. Then undo step 1 (delete the two `AUTO_START_FIX` variables, put
   `NOTIFY_TO_NUMBERS` back) and remove the proxy.

The first staging run (2026-11-19, `results/e2e/2026-11-20T01-06-15Z-staging-016.json`)
passed 3 of 3 in a row. Each issue opened 3 to 6 s after the trigger, triage took up to 3 s,
the claim under 4 s, and the Tier 1 fix 2m29s to 4m16s. Each run's patch fixed the query and
added a test. Triage filed the bug as `backend-api` where the scenario says `database`, which
the test reports as a warning.

On both targets, the daemon has to run `SANDBOX_IMAGE=page-sandbox:demo` built for the same
scenario, and page-demo `main` has to hold the same tree (`demo-sync.sh <id>`), or the PR's
diff carries more than the fix.

### Environment

| Variable                                                    | For                                                                      |
| ----------------------------------------------------------- | ------------------------------------------------------------------------ |
| `E2E_DATABASE_URL`, else `DATABASE_URL`                     | The orchestrator's database, read only. Railway's public URL for staging |
| `E2E_ORCHESTRATOR_URL`, else `ORCHESTRATOR_URL`             | The orchestrator API, for the reset's kill                               |
| `E2E_ORCHESTRATOR_API_TOKEN`, else `ORCHESTRATOR_API_TOKEN` | The orchestrator's API token, which the kill needs. Required             |
| `GITHUB_TOKEN`, `GITHUB_REPO`                               | Finding and closing the PR. Needed for `--expect pr`                     |
| `DEMO_APP_URL`                                              | Staging's app, for `--target staging` only                               |
| `E2E_LOCAL_APP_URL`                                         | Local ops scenarios' compose app (default localhost on `DEMO_APP_PORT`)  |
| `OPS_SECRET`                                                | Ops scenarios                                                            |
| `PGBOSS_SCHEMA`                                             | The orchestrator's pg-boss schema (default `pgboss`)                     |
| `POSTHOG_KEY`, `POSTHOG_HOST`                               | Local code scenarios: passed to the demo app container. Key required     |
| `E2E_DEMO_APP_PORT`, `E2E_DEMO_DATABASE_URL`                | Local code scenarios (defaults 3100 and the compose Postgres's `demo`)   |

The run's header names the app URL the scenario's scripts run against, and the database's
host, never its URL. If Railway's Postgres wants TLS, add `?sslmode=require` to the URL.
The PostHog webhook has to point at the same orchestrator whose database the test reads,
with `POSTHOG_WEBHOOK_SECRET` set there.
