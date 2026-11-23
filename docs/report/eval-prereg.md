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

Amendment 4 (2026-11-19), committed before any ops run: the ops scenarios get a run of their
own. In the frozen runs Tier 3 had no ops tools (Tier 1's commands plus the Tier 2 GitHub
tools), so the runner skipped 024, 029 and 030. #147 and #148 give Tier 3 the ops tools
(read the live settings, set or drop an override, restart), and #149 plays the ops scenarios
against a live demo app. All three came after the threshold freeze (#114) and the held-out
run, so the dev and held-out results stand as reported. The ops run plays the two dev ops
scenarios, 029 and 030, 3 runs under each config, on `deepseek/deepseek-v4.1-flash` at the
frozen limits (`threshold.ts` is unchanged since #114) and the same stop rules, with $0.75
of budget per config. The configs run one after another, since they share one live app. It
is reported as its own set, not folded into dev or held-out. The Tier 1 and Tier 2 prompts
are unchanged; the Tier 3 prompt gains the ops blocks, so Tier 3 attempts in this run see a
different prompt from the frozen runs. The bars are scored on dev only; the report shows the
same checks on this set for comparison, as it does for held-out. 024 stays unrun: it is held
out, its reservation is used, and its fix is a rollback, which has no agent tool yet.

Note (2026-11-23), not an amendment: every run this preregistration covers (the pilots, dev,
held-out and ops) came before confidence escalation. The ladder arm below climbed on step,
cost or time limit only, and no run was scored. The daemon now also escalates a submitted
run whose confidence score is under its tier's threshold (`CONFIDENCE_THRESHOLD`, next to the
frozen budgets in `threshold.ts`, which are unchanged). The bars, arms and results stay as
they were. A run with confidence escalation is a new set on dev bugs, with an amendment of
its own; the held-out reservation is used and is not run again.

Note (2026-11-23), not an amendment: after the calibration runs, the task prompt gained
three notes on commands, from refused steps on staging: it names the commands that are
refused (grep, xargs, sed, echo, cd), says `rg -t ts` covers `.tsx`, and shows a quoted path
with brackets. The system prompts are unchanged. Every result in this preregistration
describes the prompt before them. A run on the new prompt is a new set, with an amendment of
its own.

Amendment 5 (2026-11-23), committed before any run with confidence escalation: a dev-only
run to calibrate the confidence threshold (#174). The question is whether the score
(`scoreRun` in `packages/agent/src/confidence.ts`) separates submitted patches that pass
`check.sh` from ones that don't, and what `CONFIDENCE_THRESHOLD` each tier should use. Only
dev scenarios run. The held-out set is not read, run or summarized, and 024 is never run.

Each attempt in a results file keeps its tier, its exit status, `checkPassed`, its score
with every part (`confidence`: `score`, `changesCode`, `reproduced`, `testsPass`,
`checksPass`, `liveAfterChange`) and `lowConfidence`. The escalation reason follows from the
exit status and `lowConfidence` (`escalationReason` in `eval/src/runner.ts`). The check runs
on every attempt and the agent never sees its score, so one recorded score says what every
candidate threshold would have done with that attempt.

Every run uses `deepseek/deepseek-v4.1-flash` on OpenRouter at the frozen limits
(`ESCALATION_THRESHOLD` is unchanged), 3 runs per scenario. A code config plays the 18 dev
code scenarios (`--set dev` with no live app, so 029 and 030 are listed as skipped, as in the
frozen dev files) at `--concurrency 3`. An ops config plays 029 and 030 (`--set dev` and those
two ids) one run at a time against a local compose demo app, as in Amendment 4. One code
config runs at a time, and one ops config may run beside it.

1. Phase 1, at today's threshold (0.3 at every tier): tier1-only on the code scenarios (54
   runs) and on 029 and 030 (6 runs), then tier3-start on the same (54 and 6 runs). These
   four files are the calibration data.
2. Phase 2: the rule below picks each tier's threshold from the phase 1 files. If it picks a
   value other than 0.3, a PR changes `threshold.ts` and its tests before phase 3.
3. Phase 3, at the picked threshold: ladder on the code scenarios (54 runs) and on 029 and
   030 (6 runs). It measures fix rate, cost, false escalations and pages end to end, next to
   the frozen dev and ops numbers. No threshold decision rests on it; a change it suggests
   needs another amendment.

The Tier 1 and Tier 2 prompts are the ones the frozen dev runs saw. The Tier 3 prompt is the
ops set's (Amendment 4), with the ops blocks, so tier3-start code runs here see a different
Tier 3 prompt from the frozen dev runs. Gated ops calls are approved at once (`evalApprove`).

The decision rule, per tier:

- Data: phase 1's scored code fixes at that tier, from tier1-only for Tier 1 and tier3-start
  for Tier 3, code and ops scenarios pooled. A code fix is a submitted attempt whose score
  has `liveAfterChange` null. It passes when `checkPassed` is true. A submit with no score
  (the scorer threw) is left out and counted.
- Candidates: 0.2, 0.3, 0.5, 0.7, 0.8 and 1.0. A code fix scores a sum of 0.5, 0.3 and 0.2,
  so these are the only points where moving the threshold changes which fixes fall under it.
- For each candidate, false escalations F are the passing fixes that score under it (each
  would escalate, or page at Tier 3), and caught patches C are the failing fixes under it.
- A candidate is allowed when F is at most 1 in 50 of the tier's passing fixes P (F at most
  P / 50: 1 false escalation for 50 to 99 passing fixes, none below 50). #174 proposed 1 in 54.
- The pick is the allowed candidate with the most C. Ties go to the smaller F, then to 0.3,
  then to the lower candidate. A higher threshold that catches no more wrong patches only
  sends more working fixes up a tier, so the rule is not "the highest allowed candidate".
- If no candidate is allowed, the tier gets 0.2, and the report flags the scorer for scoring
  passing fixes at 0.
- A tier with fewer than 20 scored code fixes keeps 0.3.
- Tier 2 has no phase 1 data, since no single-tier config plays it. It takes Tier 1's value:
  it plays the same code task with push and PR tools added, and its fixes score on the same
  parts.
- Ops-only fixes score 0 or 1, so every candidate treats them the same. They are reported
  apart and don't enter the rule.
- `pnpm eval:tune` gets a confidence section that prints these tables and the pick, with
  tests, before it reads the phase 1 files.

The weights (`CONFIDENCE_WEIGHTS`) don't change. The frozen dev runs had 2 wrong submits in
162 runs, so phase 1 will likely see a handful of failing fixes, too few to fit three
weights. The report shows how often each part held among passing and failing fixes, for a
later amendment.

What each result leads to:

- The rule picks a value other than 0.3 at a tier: a PR sets it in `threshold.ts`, and phase
  3 plays at that commit.
- The rule keeps 0.3 at every tier: no code change, and phase 3 plays at the phase 1 commit.
- A tier has no failing code fix: the score's separation is untested there, the rule keeps
  0.3, and the report says so.
- No allowed candidate catches a failing fix, because the failing fixes score as high as the
  passing ones: moving the threshold can't help. The report lists the parts those patches
  had, as input for a scorer change under a later amendment.

Budget and stop rules:

- Spend cap: $1.60 for the whole amendment, counted as OpenRouter's `usage.cost`. The user
  approved up to $3, but the OpenRouter key had $1.94 left of its $5 limit on 2026-11-23,
  and the cap leaves room on it for other use. In the frozen runs the four phase 1 configs
  cost $1.03 and the two ladder files $0.88. Output tokens have since dropped from $0.567 to
  $0.199 per million; input is $0.0498 per million, from $0.051.
- `--max-cost` is $1.60 for a code config and $0.40 for an ops config, so no single process
  can pass the cap. A watchdog reads the key's usage every minute and pauses every eval
  process (Ctrl-C, which checkpoints) once the usage has grown $1.40 since phase 1 started.
  The $0.20 left covers the attempts in flight; the costliest attempt in the frozen runs
  spent $0.06. The key's usage counts any other use of it too, so it can only overstate this
  run's spend. A pause ends the amendment's runs, and the report says what was left.
- Before phase 3, its cost is projected from phase 1: the ladder code file at the tier1-only
  code file's spend times (1 + 2e), where e is the share of those runs the picked threshold
  would escalate (a low score or out of budget), and the ladder ops file at $0.39 times the
  ratio of phase 1 spend to $1.03. If phase 1 spend plus the projection passes $1.40, the
  ladder code file plays 1 run per bug; if it still passes, phase 3 plays only the ops file.
- The first provider failure (`stoppedForProvider`) stops the runner on its own. The file is
  resumed from its checkpoint once the provider is back. A second provider stop in the same
  file ends it, and it is reported incomplete. Never retry in a loop.
- A run in `errors` (a sandbox, script or check failure) is played again once with
  `--resume`. A run that fails twice stays out and is reported.
- A run with a `model_error` attempt is thrown out and rerun, as the bars require.
- A held-out id in any command, results file or analysis: stop. `eval:tune` refuses a file
  that names one.

The ops configs play against a local compose demo app under its own project name and ports,
with `POSTHOG_KEY` unset (checked in the running container before the first ops run) and
`OPS_SECRET` set. `DEMO_APP_URL` points at localhost only. The staging app, the staging
orchestrator and Railway are not touched. Other agents run tests on this machine, so its load
is logged every five minutes during the runs. Attempts that end on a step, cost or time limit
(`budget_exhausted` in the daemon) are reported apart, with the load, since the 14 minute
wall clock runs on shared CPUs.

Note (2026-11-23), not an amendment, on how Amendment 5 ran. Phase 1 ran as written at
`45daa76`. Its tier1-only code file stopped twice and was resumed from its checkpoint at the
same commit, as the stop rules allow: once on a provider stop (a model call timed out on the
network), and once when Docker Desktop shut down and five attempts errored, which the second
resume played again once. The rule picked 0.2 at every tier, and #193 set it. Phase 1 used
$1.08 of the key's usage, so the projection left phase 3 with only the ops file, which ran at
`7fdf982`. The amendment used $1.32 of its $1.60 cap, and the watchdog never paused a run.
The held-out set was not read or run. The results are under Confidence calibration (dev) in
[evaluation-method.md](evaluation-method.md#confidence-calibration-dev).

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

| set                                 | prior exposure                                                                                                                                                                                    | reservation                                                                                                                                                                                                                                                                             |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| held-out (10 bugs, eval/split.json) | none. No agent run has used them, and no prompt or limit was tuned on them.                                                                                                                       | Not read, run or summarized until Arjun freezes the escalation threshold. Then 1 run per config, once. Run on 2026-11-18, after the freeze in #114: 1 run per config at `de1b6d4` on `deepseek/deepseek-v4.1-flash`, 9 code bugs (024 is ops and was skipped). The reservation is used. |
| dev (20 bugs)                       | Free nemotron only: 001, 003, 004 under tier1-only, and the 9-run pilot (009, 015, 022 under each config), all 2026-11-09. gpt-oss-20b: the 9-run pilot, 0 fixed. No deepseek-v4.1-flash run yet. | All runs and tuning happen here.                                                                                                                                                                                                                                                        |
