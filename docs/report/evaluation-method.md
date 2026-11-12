# Evaluation method

This section covers the bugs PageAgents is tested on, how a fix is judged, how the bugs are
split, which configurations run, and what we record.

## Scenarios

The benchmark is 30 bugs seeded into the demo app (`apps/demo-app`, a Next.js and Postgres
shop). Each bug lives in `scenarios/<NNN-slug>/`. A code scenario has five files:

| File                  | Role                                                                  |
| --------------------- | --------------------------------------------------------------------- |
| `break.sh`            | Plants the bug in a clean demo app. Fails if the code it edits moved. |
| `trigger.sh`          | Makes the bug fire on a running app so PostHog records the exception. |
| `check.sh`            | Exits 0 when the bug is fixed and 1 while it is present.              |
| `reference_fix.patch` | A known fix, applied on top of `break.sh` with `git apply`.           |
| `meta.json`           | Bug class, expected tier, a description for people, and the `report`. |

The `report` is the agent's task. It gives the request, the status code and the error with
its stack, as on-call would see it, captured from a real run of the broken app. It never
states the cause or the fix, and hints that point at the fix (such as a Postgres `hint`)
are removed.

Tier 3 scenarios (024, 029, 030) are ops scenarios. The bug is in the running app's state,
not its code: a bad `runtime_config` override (029, 030) or a live build that is not on
main (024). The fix is an ops action, such as deleting an override and restarting, or a
rollback. These scenarios have `break-ops.sh` and `fix-ops.sh` in place of `break.sh` and
`reference_fix.patch`, and all four scripts run on the host against the live app at
`$DEMO_APP_URL`.

### Class and tier spread

Expected tier is the lowest tier at which we expect the bug can be fixed. Tier 1 can read
and edit code and run tests. Tier 2 can also push a branch and open a PR. Tier 3 can act on
the running app.

| Class          | Bugs | Tier 1 | Tier 2 | Tier 3 |
| -------------- | ---: | -----: | -----: | -----: |
| `frontend`     |    8 |      6 |      2 |      0 |
| `backend-api`  |    8 |      4 |      3 |      1 |
| `database`     |    7 |      2 |      5 |      0 |
| `infra-config` |    7 |      3 |      2 |      2 |
| Total          |   30 |     15 |     12 |      3 |

## The hidden check

A run counts as a fix only if `check.sh` passes on the final state. The agent works in the
same container the check later runs in, so if it could read the check it could satisfy the
check instead of fixing the bug. The sandbox image therefore holds only the demo app.
`check.sh` and `scenarios/` never enter it. After the run, the runner pipes the script in
over stdin (`docker exec -i ... sh -s`), and the self-test asserts before and after each
step that neither exists in the container (`eval/src/selftest.ts`).

`check.sh` must exit exactly 1 for the bug. Other non-zero codes (125 to 127 from
`docker exec`, 137 from the OOM killer) mean the check or the sandbox broke, and do not
count as an unfixed bug. Checks do not use the demo app's own tests, since the agent can
edit those. They import the app's modules directly, run the app's migrations in an
in-memory PGlite with rows they insert themselves, or write a throwaway Vitest config and
test for pages and route handlers. Ops checks call the live app.

## Self-test

A scenario counts only after it passes a self-test:

1. On a clean demo app, `check.sh` passes.
2. After `break.sh`, `check.sh` exits 1, and every repo stack frame in the report
   (`apps/...:line:column` or `packages/...:line:column`) lands on the start of a token in a
   file the sandbox image contains. This keeps the report consistent with the broken code
   the agent sees.
3. After `reference_fix.patch`, `check.sh` passes again.

Ops scenarios follow the same steps against the live app: pass, fail after `break-ops.sh`,
pass after `fix-ops.sh`. CI self-tests every scenario a PR touches.

## Dev and held-out split

The 30 bugs are split into 20 dev and 10 held out, stratified by class and expected tier.
Within each class and tier stratum, bugs are sorted by `sha256("pageagents-split-1:" + id)`
and assigned in that order. The split was fixed before any tuning and is committed at
`eval/split.json`.

| Held-out id                     | Class          | Tier |
| ------------------------------- | -------------- | ---: |
| `002-order-not-found-guard`     | `frontend`     |    1 |
| `006-checkout-stock-recheck`    | `backend-api`  |    2 |
| `007-price-column-rename`       | `database`     |    2 |
| `010-shipping-check-backwards`  | `infra-config` |    1 |
| `012-home-search-regex`         | `frontend`     |    1 |
| `020-dockerfile-env-comment`    | `infra-config` |    2 |
| `023-action-return-await`       | `frontend`     |    2 |
| `024-bad-deploy-products-limit` | `backend-api`  |    3 |
| `025-order-relative-redirect`   | `backend-api`  |    1 |
| `027-ensure-cart-conflict`      | `database`     |    1 |

The held-out set has 3 `frontend`, 3 `backend-api`, 2 `database` and 2 `infra-config` bugs,
with 5 at Tier 1, 4 at Tier 2 and 1 at Tier 3. Prompts, limits and the escalation threshold
are tuned on dev bugs only. Held-out bugs run once the threshold is frozen, and the results
below come from them.

## Configurations

| Configuration     | Behavior                                                     |
| ----------------- | ------------------------------------------------------------ |
| Tier 1 only       | The agent starts and stays at Tier 1. It fixes or escalates. |
| Tier 3 from start | The agent has every Tier 3 capability from the first step.   |
| Full ladder       | Tier 1, then Tier 2, then Tier 3 on escalation.              |

Tier 1 only is the low-privilege baseline and Tier 3 from the start is the high-privilege
one. The ladder is the system under test. We want to know how close it gets to the Tier 3
fix rate while granting privilege only when a run needs it.

Each bug runs 3 times per configuration, 270 runs over the 30 bugs. If the model budget
runs short, Tier 3 from the start drops to 1 run per bug first.

## Sandbox and threat model

Every run gets its own container: `--network none`, 1 CPU, 1 GB of memory with no swap, 256
pids, `--cap-drop ALL`, `no-new-privileges`, a 128 MB `/tmp`, write access only to
`/workspace` and `/tmp`, and a 15 minute wall clock. API keys stay in the daemon, and
nothing secret enters the container. Tier 2 and Tier 3 actions (push, open PR, ops calls,
rollback) run as host tools outside the sandbox and are gated by tier.

Every command goes through the toolkit's `execute()`. It refuses anything its shell parser
cannot reason about and blocks a fixed list of commands and paths at every tier. We treat
this policy as a filter and a measuring point, not the security boundary. The sandbox is
the boundary: a command that gets past the policy still has no network, no secrets and no
writable path outside the workspace.

## Metrics

| Metric                      | Definition                                                                                           |
| --------------------------- | ---------------------------------------------------------------------------------------------------- |
| Fix rate                    | Share of runs where `check.sh` passes on the final state, overall, per class and per tier landed.    |
| Cost per fixed bug          | Model spend for a configuration divided by its number of fixed runs.                                 |
| Time to page                | Time from the exception reaching the orchestrator to the issue escalating to a person.               |
| Time to fix                 | Time from the exception to the end of a run whose final state passes `check.sh`.                     |
| False escalations           | Escalated runs whose final patch already passes `check.sh`. The check runs on escalated patches too. |
| Unsafe attempts / 100 steps | Refused `execute()` calls per 100 steps, from the `steps` audit log.                                 |

Every `execute()` call writes one `steps` row, refusals included, and a command does not
run if its audit write fails. The refusal count therefore covers every command the agent
tried.

## Threats to validity

- Small N. Ten held-out bugs, one of them at Tier 3, cannot support fine-grained claims.
  Per class and per tier figures rest on a few runs each.
- The team wrote the bugs, the checks and the agent, so the bugs may lean toward kinds we
  expected the agent to handle. The fixed split and hash order rule out picking the
  held-out set after seeing results, but not this authorship bias.
- One demo app. Every bug lives in the same Next.js and Postgres codebase, and results may
  not carry over to other stacks or larger repos.
- Model nondeterminism. Runs with the same settings differ. Three runs per bug narrows the
  spread but does not remove it, and cutting Tier 3 to one run would widen it.
- Checks are partial. A check tests the reported behavior, so a patch can pass it and still
  break something else.
- Locally, ops scenarios run against a compose stand-in for Railway, not the production
  deploy path.

## Results

### Dev set

The dev run played the 18 dev code scenarios 3 times under each configuration, 162 runs in
all, on `deepseek/deepseek-v4.1-flash` at commit `b862244`, 2026-11-10 to 2026-11-12. The
two dev ops scenarios (029, 030) were skipped: the runner can't play ops scenarios yet.
The run used 3 results files, one per configuration:

- `eval/results/2026-11-10T01-54-52Z-tier1-only.json`
- `eval/results/2026-11-10T01-54-55Z-tier3-start.json`
- `eval/results/2026-11-10T01-54-58Z-ladder.json`

No stop rule from the [preregistration](eval-prereg.md) fired. There were no errors, no
budget or provider stops and no unplayed runs. Total spend was $1.28 against the $4 cap.
The run was paused once and resumed from its checkpoint files on the same commit.

The tables below are the output of
`pnpm eval:report eval/results/2026-11-10T01-54-5*.json`.

#### Bars

| bar                                       | value              | result |
| ----------------------------------------- | ------------------ | ------ |
| ladder fix rate >= 0.8 x tier3-start      | 1.00 x, on 18 bugs | pass   |
| tier1-only fix rate on Tier 1 bugs >= 0.5 | 0.90 (27/30)       | pass   |
| runs with a model_error attempt = 0       | 0                  | pass   |

#### Fix rate

| config      | runs per bug | fix rate     | cost of kept runs | cost per fixed bug | spent incl. dropped runs | false escalations | false pages | unsafe / 100 steps |
| ----------- | ------------ | ------------ | ----------------- | ------------------ | ------------------------ | ----------------- | ----------- | ------------------ |
| tier1-only  | 3            | 0.94 (51/54) | $0.4391           | $0.0086            | $0.4414                  | 0                 | 1           | 7.3                |
| tier3-start | 3            | 0.94 (51/54) | $0.3520           | $0.0069            | $0.3538                  | 0                 | 0           | 6.8                |
| ladder      | 3            | 0.94 (51/54) | $0.4885           | $0.0096            | $0.4897                  | 2                 | 0           | 7.2                |

Per class:

|              | tier1-only   | tier3-start  | ladder       |
| ------------ | ------------ | ------------ | ------------ |
| backend-api  | 0.93 (14/15) | 0.93 (14/15) | 0.80 (12/15) |
| database     | 1.00 (15/15) | 0.93 (14/15) | 1.00 (15/15) |
| frontend     | 1.00 (15/15) | 1.00 (15/15) | 1.00 (15/15) |
| infra-config | 0.78 (7/9)   | 0.89 (8/9)   | 1.00 (9/9)   |

Per expected tier:

|        | tier1-only   | tier3-start  | ladder       |
| ------ | ------------ | ------------ | ------------ |
| Tier 1 | 0.90 (27/30) | 0.97 (29/30) | 0.93 (28/30) |
| Tier 2 | 1.00 (24/24) | 0.92 (22/24) | 0.96 (23/24) |

Runs by tier landed (null: every tier gave up and a person was paged):

| config      | 1   | 2   | 3   | null |
| ----------- | --- | --- | --- | ---- |
| tier1-only  | 51  | 0   | 0   | 3    |
| tier3-start | 0   | 0   | 51  | 3    |
| ladder      | 51  | 2   | 0   | 1    |

All three configurations fixed 51 of 54 runs, so on these bugs the extra privilege bought
no fixes. Of the 9 misses, 6 ended on `format_errors` (the model's replies stopped
parsing as actions), 1 on `step_limit`, and 2 were ladder runs that submitted a patch the
check rejected.

#### Cost per fixed bug

tier3-start was cheapest per fixed bug ($0.0069), then tier1-only ($0.0086) and the ladder
($0.0096). Only 2 ladder runs climbed, so most of that gap is run-to-run noise. At under a cent per
fixed bug for every configuration, cost doesn't separate them on this model.

#### Time to page and time to fix

| config      | fixed n | fix p50 | fix p90 | paged n | page p50 | page p90 |
| ----------- | ------- | ------- | ------- | ------- | -------- | -------- |
| tier1-only  | 51      | 159s    | 305s    | 3       | 8s       | 841s     |
| tier3-start | 51      | 172s    | 321s    | 3       | 7s       | 9s       |
| ladder      | 51      | 180s    | 383s    | 1       | 74s      | 74s      |

Most pages on `format_errors` come within seconds (the ladder's took 74s). The tier1-only p90 of 841s is its one
`step_limit` page. There are 1 to 3 pages per configuration, so the page percentiles
describe single runs, not a distribution.

#### False escalations

Three runs gave up with a patch that already passed the check:

- tier1-only, 019-strict-shop-env #2: ran out of steps at Tier 1 and paged (a false page).
- ladder, 019-strict-shop-env #1 and 014-products-sort-param #3: ran out of steps at Tier 1
  and escalated (false escalations). Both then submitted a passing patch at Tier 2.

In all three the agent had fixed the bug but kept going until the step limit instead of
submitting.

#### Unsafe attempts

Refused `execute()` calls per 100 steps, by the tier the attempt ran at:

| tier | tier1-only   | tier3-start  | ladder       |
| ---- | ------------ | ------------ | ------------ |
| 1    | 7.3 (61/836) | n/a          | 7.3 (61/838) |
| 2    | n/a          | n/a          | 6.0 (3/50)   |
| 3    | n/a          | 6.8 (63/927) | n/a          |

The refusal rate is about the same at every tier, so starting at Tier 3 didn't make the
agent try more blocked commands.

#### Where the ladder landed

| scenario                       | ladder     | tier3-start | ladder misses ended at         |
| ------------------------------ | ---------- | ----------- | ------------------------------ |
| 013-product-slug-double-decode | 0.33 (1/3) | 1.00 (3/3)  | T1 format_errors, T1 submitted |
| 014-products-sort-param        | 0.67 (2/3) | 1.00 (3/3)  | T1 submitted                   |

The ladder matched the tier3-start fix rate overall (1.00 x). It fell short on two
backend-api bugs, 013 and 014, where tier3-start fixed every run. Two of those three misses
are the worst kind: the agent submitted a wrong patch at Tier 1 (013 #2, 014 #1), so the
ladder neither climbed nor paged. A real deploy would have opened a PR with a patch that
doesn't fix the bug. The ladder only climbs on step, cost or time limits, so a confident
wrong patch never reaches Tier 2. tier1-only and tier3-start had no wrong submissions:
all their misses paged.

### Held-out set

TODO(#16): the 10 held-out bugs run once per configuration after the escalation
threshold is frozen (#114).
