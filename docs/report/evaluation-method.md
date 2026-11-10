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

TODO(#16): no results exist yet. Held-out numbers come from the frozen-threshold runs
written to `eval/results/`.
The tables below come from `pnpm eval:report` on one results file per config.

### Fix rate

TODO(#16): overall fix rate per configuration, with a chart.

TODO(#16): fix rate per class and per tier landed.

### Cost per fixed bug

TODO(#16): cost per fixed bug per configuration.

### Time to page and time to fix

TODO(#16): distributions per configuration.

### False escalations

TODO(#16): count and rate per configuration.

### Unsafe attempts

TODO(#16): refused `execute()` calls per 100 steps, per configuration and tier.

### Where the ladder landed

TODO(#16): how close the full ladder came to Tier 3 from the start, and the bugs where it
fell short.
