# Eval preregistration: 30-bug evaluation (#16)

Frozen when committed, before the pilot. A bar, arm, decoy or stop rule changed after the
pilot starts means a new preregistration.

Amendment 1 (2026-11-09), committed before any run on the new model: the arms move from
`nvidia/nemotron-3-ultra-550b-a55b:free` to `openai/gpt-oss-20b`. The free model's quota
(about 1,000 requests a day) put the dev run at about 4 days, from the nemotron pilot's 22
calls per run. Bars, decoys and the held-out reservation are unchanged. The stop rules
change from quota to spend. The nemotron pilot (9 runs, 9 fixed, $0) is kept as a record and
is not part of the results. The pilot reruns on the new model before the full run.

Amendment 2 (2026-11-09), committed before any run on the new model: the arms move from
`openai/gpt-oss-20b` to `deepseek/deepseek-v4.1-flash`. The gpt-oss-20b pilot fixed 0 of 9:
every run ended on `format_errors` after 3 replies and 0 commands. gpt-oss answers in
OpenAI's Harmony format and sends our action tags (`page_bash`, `page_edit`) through its
tool-call channel instead of the reply text, so the reply comes back empty (some providers
return `finish_reason: error`). A probe with the real agent prompt parsed 0 of 4 replies on
gpt-oss-20b, 1 of 2 on gpt-oss-120b and 3 of 3 on deepseek-v4.1-flash. The agent's prompt
is not changed to suit one model. Bars, decoys, stop rules and the held-out reservation are
unchanged. The gpt-oss-20b pilot ($0.0004) is kept as a record, not as results.

Amendment 3 (2026-11-12), committed before the threshold freeze (#114) and before any
held-out run: the per-attempt wall clock under Arms reads 14 min, not 15. The agent has used
14 min since #57 (the sandbox kills the container at 15, so each tier stops a minute before),
and every dev run used 14. This corrects the text to match the code; no run changes.

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

All arms use `deepseek/deepseek-v4.1-flash` on OpenRouter, with the agent's default limits
(40 steps, $0.50, 14 min per attempt). Price: $0.051 per million input tokens and $0.567 per
million output tokens (OpenRouter `/models`, 2026-11-09). The probe measured about $0.0002
per call, so about $0.005 per run and $0.70 to $1.50 for the dev run; the pilot measures it. The gstack price table has no row for
this model, so arms are priced from OpenRouter, and the runner records `usage.cost` for
every call.

- `deepseek-v4.1-flash#tier1-only`: starts and stays at Tier 1.
- `deepseek-v4.1-flash#tier3-start`: starts at Tier 3.
- `deepseek-v4.1-flash#ladder`: Tier 1, then 2, then 3 on step, cost or time limit.

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

- Spend cap: $4 for the whole dev run, split as `--max-cost` per config, under the key's
  $5 limit. The runner stops a config when its share runs out (`stoppedForBudget`). The
  pilot gets $0.50.
- Pilot projects more than $4 for the dev run: stop and cut tier3-start to 1 run per bug,
  as the method doc allows.
- The first provider failure (`stoppedForProvider`: a 429, used-up credits, an outage): the
  runner stops on its own. The affected run is in `errors`; rerun it and everything after
  it once the provider is back. Never retry in a loop.
- Any other entry in `errors` (sandbox or `break.sh` failure) during the pilot: stop and
  fix the harness before the full run.
- Pilot misses the `model_error` bar: stop and fix the runner before the full run.

## Held-out exposure

| set                                 | prior exposure                                                                                                                                                                                    | reservation                                                                                            |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| held-out (10 bugs, eval/split.json) | none. No agent run has used them, and no prompt or limit was tuned on them.                                                                                                                       | Not read, run or summarized until Arjun freezes the escalation threshold. Then 1 run per config, once. |
| dev (20 bugs)                       | Free nemotron only: 001, 003, 004 under tier1-only, and the 9-run pilot (009, 015, 022 under each config), all 2026-11-09. gpt-oss-20b: the 9-run pilot, 0 fixed. No deepseek-v4.1-flash run yet. | All runs and tuning happen here.                                                                       |
