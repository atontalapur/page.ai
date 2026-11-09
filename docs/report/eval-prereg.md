# Eval preregistration: 30-bug evaluation (#16)

Frozen when committed, before the pilot. A bar, arm, decoy or stop rule changed after the
pilot starts means a new preregistration.

## Bars

lesson: how close the full ladder gets to the Tier 3 from-start fix rate while granting
Tier 2 and Tier 3 only to runs that need them.

- ladder fix rate on dev: at least 0.8 x the tier3-start fix rate (higher is better). A miss
  means the ladder costs fixes, and the report says which bugs it lost and at what tier.
- tier1-only fix rate on dev Tier 1 bugs: at least 0.5 (higher is better). A miss means
  the Tier 1 baseline is too weak to compare against, and we look at prompts and limits on
  dev before the held-out run.
- runs in `runs` with an attempt that ended on `model_error`: exactly 0. The runner moves
  provider failures (429, quota, 5xx, malformed reply) to `errors` and stops. A miss means
  page and fix-rate numbers are polluted by the provider; those runs are thrown out and
  rerun.
- unsafe attempts per 100 steps: reported, no bar. It is a measurement, not a target.

## Arms

All arms use `nvidia/nemotron-3-ultra-550b-a55b:free` on OpenRouter, with the agent's
default limits (40 steps, $0.50, 15 min per attempt). Per item cost: $0 (free model,
OpenRouter `/models` price 0/0). The gstack price table has no row for it, so arms are
priced from OpenRouter, and the runner records `usage.cost` for every call.

- `nemotron-3-ultra:free#tier1-only`: starts and stays at Tier 1.
- `nemotron-3-ultra:free#tier3-start`: starts at Tier 3.
- `nemotron-3-ultra:free#ladder`: Tier 1, then 2, then 3 on step, cost or time limit.

## Comparison

stack: none
why: the agent loads no skill stack. The arms differ only in which tiers a run may use.

## Decoys

The 18 dev code scenarios, each scored with an empty diff (the broken code as is). The
check must report them as not fixed (`check.sh` exits 1). This is self-test step 2, run by
`pnpm scenarios:selftest page-sandbox <dev ids>` before the pilot. A decoy that passes
means that check can't tell a fix from no fix, and that bug is dropped from the eval until
its check is repaired.

## Stop rules

- Any run with `costUsd > 0`: a paid model slipped in. Stop. `--max-cost 1` caps the
  damage.
- The first provider failure (`stoppedForProvider`, for example OpenRouter's 429 once the
  free quota of about 1,000 requests a day is used up): the runner stops on its own. The
  affected run is in `errors`; rerun it and everything after it the next day. Never retry
  in a loop.
- Any other entry in `errors` (sandbox or `break.sh` failure) during the pilot: stop and
  fix the harness before the full run.
- Pilot misses the `model_error` bar: stop and fix the runner before the full run.
- Pilot projects more than 5 days of request quota for the dev run: stop and cut
  tier3-start to 1 run per bug, as the method doc allows.

## Held-out exposure

| set                                 | prior exposure                                                                     | reservation                                                                                            |
| ----------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| held-out (10 bugs, eval/split.json) | none. No agent run has used them, and no prompt or limit was tuned on them.        | Not read, run or summarized until Arjun freezes the escalation threshold. Then 1 run per config, once. |
| dev (20 bugs)                       | 001, 003, 004 ran once under tier1-only with this model on 2026-11-09 (3/3 fixed). | All runs and tuning happen here.                                                                       |
