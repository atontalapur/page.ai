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
  and fail when they are.
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
pnpm eval:run page-sandbox --config ladder --set dev --runs 3 --max-cost 5
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
  that paged with a passing patch as a false page.
- From Tier 2 the agent's push and PR go to an in-memory GitHub, never the demo repo.
- `--max-cost` is the total budget. Each attempt's agent limit is lowered to what is
  left, and no attempt starts with less than $0.05 left. A run the budget cut short, at
  any tier, is dropped and flagged with `stoppedForBudget`. The agent checks its limit
  before each model call, so the total can go over by one call's cost.
- Ops scenarios (Tier 3) are skipped with a reason for now: they need a live demo app.
- An attempt that throws (a sandbox or `break.sh` failure) goes in `errors` and its run
  is left out; the eval goes on. Its spend is unknown, so its whole limit counts against
  the budget.
- Results go to `eval/results/<start>-<config>.json` (`src/results.ts` has the schema):
  per run the tiers tried, tier landed, fixed, paged, time to fix or page, cost, steps
  and blocked steps, and the agent's diff; plus a summary.
- `.github/workflows/eval-nightly.yml` runs the first 10 dev scenarios under `ladder`
  every night at 2 a.m. Pacific, with a $1 budget, and commits the results to the
  `eval/nightly-results` branch. It needs the `OPENROUTER_API_KEY` secret and the
  `OPENROUTER_MODEL` repository variable.
