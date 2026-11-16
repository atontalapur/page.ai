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
  scenarios (024, 029, 030) are in the split, but the runner can't play them yet and
  lists them as skipped.

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
- Ops scenarios (Tier 3) are skipped with a reason for now: they need a live demo app.
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
pnpm e2e 001-bad-currency-code --target staging --runs 3
```

`pnpm e2e` plays one scenario through the live pipeline: it seeds the bug, runs
`trigger.sh`, then waits on the orchestrator's database for each step and checks the end
state. It loads `.env` if there is one (`--env-file-if-exists`). It talks to real
PostHog, the orchestrator, the node daemon and GitHub, so the daemon has to be up with a
model key. `src/e2e.ts` has the steps, behind ports that the unit tests fake;
`src/e2e-adapters.ts` and `scripts/e2e-targets.ts` are the real adapters.

Until the rest of the pipeline lands, a run stops at `claim`: nothing applies `start_fix`
after triage, and the gateway that would carry the daemon's `node.run.finished` back to
the orchestrator is a stub. The test is written for the pipeline as designed.

| Step      | Waits for                                                                          | Default limit         |
| --------- | ---------------------------------------------------------------------------------- | --------------------- |
| `seed`    | the bug live on the target (see below)                                             | 20m                   |
| `trigger` | `trigger.sh` to exit 0                                                             | 2m                    |
| `issue`   | an `issues` row opened after the trigger, titled like the report's error           | 5m                    |
| `triage`  | the issue to leave `new`                                                           | 2m                    |
| `claim`   | a fix run on the issue that a daemon picked up (pg-boss job, steps or row)         | 5m                    |
| `fix`     | the issue to wait on a human, following each tier of a ladder climb                | 16m per expected tier |
| `outcome` | an open PR from `pageagents/<runId>`, or `awaiting_approval` or a pending approval | 2m                    |
| `reset`   | the reset below                                                                    | 10m                   |

Change a limit with `--timeout fix=20m`. A step that runs out names the last state it
saw, such as `issue triaged at tier -, no run (nothing sent start_fix after triage)`.
The orchestrator titles an issue with the whole exception, `<type>: <message>`, so the
`issue` step matches the title's first line against the report's error line (a ZodError
is `ZodError: [`). Any other issue seen meanwhile is ignored, and if none matches the step
runs out listing the titles it saw. A scenario that can't pass (no error line in its
report, or `--expect pr` without `GITHUB_TOKEN` and `GITHUB_REPO`) is refused before
seeding, so there is nothing to reset.
The `fix` step also fails when the issue ends `failed` or `killed`, and when the run's job
has finished but the issue is still `fixing` a minute later (its result never reached the
orchestrator).

`--expect pr` waits for a PR; `--expect approval` for a human approval. The default is
`pr` for a Tier 2 code scenario and `approval` otherwise, since Tier 1 can't push and
Tier 3 asks before an ops action. The checks after the outcome: the issue's status, its
class and severity set, the run it ended on, at least one `steps` row, a fix job that
didn't fail, the `runs` row (when there is one) and its `pr_url` matching the PR, and the
time from the trigger to the outcome within `--budget` (default 20m). A class or tier
other than the scenario's, and a missing `runs` row (nothing writes them yet), are warnings.

The reset runs after every outcome, a failed step included: it closes any open PR from the
test's runs, kills the issue through `POST /issues/:id/events` so the next trigger opens a
new one, and unseeds the target. A failed reset fails the run, since the next one would
start dirty. `--keep` skips it, to look at the PR or the issue; clean up by hand after.
Ctrl-C skips it too. `--runs 3` plays the scenario three times and stops at the first
failure, which is the card's bar. Only dev bugs run, as with `demo-sync.sh`. The exit code
is 0 when every run passed, 1 when one failed and 2 for bad arguments.

### Targets

`--target local` (the default) runs the demo app on this machine; the orchestrator and
daemon can be the Railway ones or local ones.

- A code scenario builds `page-sandbox` and `page-sandbox:demo` with the scenario seeded,
  then serves the demo app from that image with `next dev` in a container named
  `page-e2e-demo-app`, on `E2E_DEMO_APP_PORT` (default 3100, so the compose app keeps 3000).
  Dev mode because some bugs, 001 among them, throw while `next build` prerenders. The
  container migrates and seeds the `demo` database of the compose Postgres (`pnpm db:up`)
  first. The unseed removes the container. `--no-build` reuses the images already built.
- An ops scenario runs `break-ops.sh` and `fix-ops.sh` against the compose demo app at
  `DEMO_APP_URL` (default `http://localhost:3000`), started with `OPS_SECRET` set.

`--target staging` runs against the deployed app at `DEMO_APP_URL`. The test never deploys,
so a code scenario's bug must already be live there: staging serves the seeded demo baseline
(`infra/sandbox/demo-sync.sh <id>`, `docs/demo-repo.md`). Seeding only waits for
`/api/health`, and since the reset closes the agent's PR, `main` keeps the bug for the next
run. An ops scenario runs `break-ops.sh` and `fix-ops.sh` there. A bad deploy (024) needs
the compose stand-in and is refused.

On both targets, the daemon has to run `SANDBOX_IMAGE=page-sandbox:demo` built for the same
scenario, and page-demo `main` has to hold the same tree (`demo-sync.sh <id>`), or the PR's
diff carries more than the fix.

### Environment

| Variable                                        | For                                                                      |
| ----------------------------------------------- | ------------------------------------------------------------------------ |
| `E2E_DATABASE_URL`, else `DATABASE_URL`         | The orchestrator's database, read only. Railway's public URL for staging |
| `E2E_ORCHESTRATOR_URL`, else `ORCHESTRATOR_URL` | The orchestrator API, for the reset's kill                               |
| `GITHUB_TOKEN`, `GITHUB_REPO`                   | Finding and closing the PR. Needed for `--expect pr`                     |
| `DEMO_APP_URL`                                  | Staging's app; the compose app for local ops scenarios                   |
| `OPS_SECRET`                                    | Ops scenarios                                                            |
| `PGBOSS_SCHEMA`                                 | The orchestrator's pg-boss schema (default `pgboss`)                     |
| `POSTHOG_KEY`, `POSTHOG_HOST`                   | Local code scenarios: passed to the demo app container                   |
| `E2E_DEMO_APP_PORT`, `E2E_DEMO_DATABASE_URL`    | Local code scenarios (defaults 3100 and the compose Postgres's `demo`)   |

The run prints the database's host, never its URL. If Railway's Postgres wants TLS, add
`?sslmode=require` to the URL. The PostHog webhook has to point at the same orchestrator
whose database the test reads, with `POSTHOG_WEBHOOK_SECRET` set there.
