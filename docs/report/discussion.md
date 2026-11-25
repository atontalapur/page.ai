# Discussion and limitations

This section reads the [Results](evaluation-method.md#results) against the question the
evaluation asks, lists what the system can't do yet and the risks it carries, and names the
next steps the sources already point to. It describes `main` at `b53eb48` (2026-11-23), plus
the Amendment 6 run at `fae9c77` (2026-11-24).

## What the results show

On the code bugs, extra privilege bought no fixes. Each configuration fixed 51 of 54 dev runs.
On the held-out set, tier1-only and the ladder fixed 9 of 9 and tier3-start 8 of 9. The ladder
matched the tier3-start fix rate on both sets (1.00 x on dev, 1.13 x on held-out) while
granting a higher tier to 2 of 54 dev runs and to none of the 9 held-out runs. Every
configuration stayed under a cent per fixed bug, so on this model cost doesn't separate them.
The rate of refused commands was about the same at every tier, so starting at Tier 3 didn't
make the agent try more blocked commands.

The ops set is the first where a lower tier can't fix the bug, so climbing decides the result.
tier1-only fixed 0 of 6, tier3-start 5 of 6 and the ladder 3 of 6, which misses the 0.8 bar
(0.60 x). The ladder fixed 030 every time, after running out of steps at Tier 1 and Tier 2 and
climbing. It missed 029 every time: a lower tier traced the 500 to the setting, wrote a code
patch with a test, and submitted. Climbing was also slow and costly here. The ladder's fixes
took a median of 822 seconds against tier3-start's 27, and cost $0.1296 per fixed bug against
$0.0080.

The results show two ways the ladder goes wrong, and they pull in opposite directions:

- A confident wrong patch at a lower tier neither climbs nor pages. This hit 2 of 54 dev
  ladder runs (013, 014) and all 3 ladder runs of 029. In a deploy, that patch goes to a person
  for approval as if it were a fix.
- A run that has fixed the bug keeps going until a limit. Three dev runs did this (one false
  page, two false escalations), and so did tier3-start's held-out run of 020, which hit the
  wall clock.

Most dev misses came from the model, not the tiers. Of the 9 dev misses, 6 ended on
`format_errors`, where the model's replies stopped parsing as actions. Before the dev run, the
gpt-oss-20b pilot fixed 0 of 9 because the model sent the action tags through its tool-call
channel instead of its reply ([Amendment 2](eval-prereg.md)).

Amendment 6 played the ladder as it stood at `fae9c77`, scoring on at 0.2, on the 18 dev code
bugs ([Ladder at 0.2 on the dev code bugs](evaluation-method.md#ladder-at-02-on-the-dev-code-bugs-amendment-6)).
It fixed 42 of 54, against the frozen dev ladder's 51. The machine slept through three round-3
runs, which ended on the time limit. Each of the other 9 misses ended on `format_errors`,
where the frozen dev ladder had 1 such attempt in 54 runs. The results files don't keep the
replies, so the cause is unknown.

## What the results don't show

Every run in the Results came before confidence escalation. The ladder that runs today also
climbs on a submitted patch that scores under its tier's threshold, so it is not the ladder
those runs measured, and their files don't keep the steps the score reads, so they can't be
scored after the fact. The dev calibration later played the ladder with scoring on, on 029 and
030 only, and the score doesn't catch 029: the ladder landed a wrong code patch three times
again, and each scored 1
([Confidence calibration (dev)](evaluation-method.md#confidence-calibration-dev)). Whether it
would catch 013 or 014 is still not known. The calibration's runs of those bugs held no wrong
patch, and neither did Amendment 6's ladder on the dev code bugs: all 43 of its submitted
patches passed `check.sh`, and it fixed 013 and 014 at Tier 1 in every run.

The held-out set doesn't test climbing, since the ladder never climbed there, and it says
nothing about ops bugs, since 024 was skipped. No run has used the rollback tool. The four
held-out bugs expected at Tier 2 were all fixed at Tier 1, because the check scores only the
patch, and Tier 2 adds pushing a branch and opening a PR, which the eval sends to an in-memory
GitHub. So the eval doesn't measure the PR path. Outside the eval, a Tier 2 dry run opened
page-demo#4 with only the fix line in its diff (#115), and the first staging end-to-end run
fixed 016 three times at Tier 1 ([eval/README.md](../../eval/README.md)).

No result includes a person. The eval approves every gated ops call at once (`evalApprove`),
so ops times leave out the wait for approval, up to 3 minutes a call. A typical settings fix
needs two approved calls, the change and the restart (#176).

The threats in [evaluation-method.md](evaluation-method.md#threats-to-validity) apply to all of
this: small N, bugs and checks written by the team that wrote the agent, one demo app, model
nondeterminism, checks that test only the reported behavior, and a compose stand-in for Railway
on the ops set. The ops set is 2 bugs and 18 runs, and its Tier 3 prompt differed from the one
the dev and held-out runs saw.

## What the system can't do yet

- A person can ask a run a question from the incident page (`run.chat`, #192), but the agent
  reads it only at its next step boundary, so it waits out the model call in flight. A run
  takes at most 10 messages, and a message to a daemon that dies stays pending until the fix
  job expires ([orchestrator README](../../apps/orchestrator/README.md)).
- No rollback has run against Railway. A read-only check ran the planner against staging's real
  deployment list, through a guard that let only that query out. The query, its fields and the
  parsing held, and the planner found no target, since the older deployments were skipped or
  no longer redeployable. The staging node gets the rollback tool only once a Railway project
  token exists for it (#178).
- The node daemon runs as a Railway service on staging (`SANDBOX_RUNTIME=local`, #163) and
  connects as `railway-staging`, but no fix has run through it yet, so #163's "run a staging fix
  end to end" is still open. The staging run on record used a daemon on a local machine. On
  Railway the sandbox also loses its network block and its per-run CPU and memory limits
  ([ADR 0001](../adr/0001-sandbox-network-policy.md)).
- A fix that adds a dependency can't be tested in the sandbox until the image is rebuilt, since
  the sandbox has no network.
- A push copies whole files from the sandbox to the demo repo, so the two have to start from the
  same tree. If they drift, a PR can undo `main`'s side of any file the agent touched
  ([docs/demo-repo.md](../demo-repo.md)).
- On a Twilio trial account the call plays Twilio's sample speech and the text is its alert
  template, so neither names the issue ([docs/twilio.md](../twilio.md)).

## Risks

### Untrusted reports

The agent's task is built from a production error, and an outside user can shape that error
(#174). The stored report drops bodies, headers, cookies, query values and email addresses, and
ingest masks the input a `JSON.parse` error quotes ([docs/posthog.md](../posthog.md)). The
exception message and the request line still reach the model, so a report can carry text
written to steer the agent. What bounds such a run is the rest of the design: no network and no
secrets in the Docker sandbox, the tier policy in `execute()`, a person's approval before any
Tier 3 change to the live app, and no merge tool at Tier 2. Two gaps remain. At Tier 2,
whatever the model writes goes into a public PR. On the local runtime, a command can reach the
internet. The confidence score reads only exit codes, summary lines and paths, never the report
or the diff as instructions, but the tests it counts are ones the agent can write or edit
(#174). The eval's reports are captured from real runs of the broken app, so it doesn't test a
hostile one.

### Approval identity

Each person can have a personal dashboard token (#189). Once `DASHBOARD_TOKENS` lists any,
only a personal token decides a Tier 3 approval or sends `run.chat`, and the record names that
person as `ui:<name>`. The shared API token still reads everything and sends issue events such
as `start_fix`, `kill` and `approve`, recorded as `api:shared`, which names no one. Where
`DASHBOARD_TOKENS` is unset, as in local runs, the old fallback holds: the name a tab gives is a
label anyone with the shared token can choose
([orchestrator README](../../apps/orchestrator/README.md)). Staging lists one person so far, and
a leaked personal token acts as that person until their entry is replaced. The demo repo has a
similar gap. Agent PRs are authored with the owner's
token, so its ruleset requires no approval, and a leaked token is write access to `main`
([docs/demo-repo.md](../demo-repo.md)).

### One orchestrator instance

Live events, daemon tracking and approval deadlines live in one orchestrator process, so it runs
as a single instance ([README](../../README.md#status)). Rate limits are counted in memory per
instance too. A second instance would split the dashboard's live view, though a kill sent on
one would still reach the daemon on its next event, since that check reads the database (#173).
The node's claim on the live app has a gap of its own: an eval on another machine doesn't see it.

### Rollback and the live app

A rollback replaces the whole live build, and it is the one Tier 3 change that a failed run
keeps rather than undoes. It has never run against Railway. If someone deploys while a rollback
waits, the wait reports on that deployment instead (#172). 024, the only scenario whose fix is a
rollback, is held out and was never run.

### Confidence, calibrated on dev only

The weights (0.5, 0.3, 0.2) are a judgment call, not fitted. The threshold is 0.2 at every
tier since #193, the value [Amendment 5](eval-prereg.md)'s rule picked from 98 scored code
fixes on dev bugs ([Confidence calibration (dev)](evaluation-method.md#confidence-calibration-dev)).
At 0.2 a code fix escalates only when it scores 0, so the score fires on missing evidence,
not weak evidence. At 0.3, four working Tier 3 fixes that only saw the bug fail paged a
person; at 0.2 they land. A score of 0 can still hit a working fix. In Amendment 6, 011 #3's
Tier 1 patch passed `check.sh` but scored 0, since no test, typecheck or lint passed after its
last edit and no test failed before its first, so the ladder climbed and Tier 2 fixed the bug
again. That is 1 false escalation in 42 passing Tier 1 fixes, more than the 1 in 50 Amendment
5's rule allows. The weakness shows most in the wrong patches. Phase 1's one failing fix,
a code patch for ops bug 029 that brought its own passing test, scored 0.7, above five working
fixes, and phase 3's ladder landed three more such patches on 029, each scoring 1. No
threshold the rule allows catches them. The score doesn't check that the patch touches the
code in the report's stack, or that the reported error is gone (#174).

## Next steps

1. Find out why the model's replies stop parsing. Each Amendment 6 miss the sleep didn't cause
   ended on `format_errors`, and the results files don't keep the replies. Keep an attempt's
   failed replies in the results file first, so the next paid run shows what the model sent.
2. The wrong patches scored as high as working ones, and one working fix scored 0, so change
   the scorer under a later amendment. #174 names what it lacks: a check that the patch touches the code in the stack, and
   one that the reported error is gone.
3. Create the staging Railway project token (#178), so the staging node gets the rollback
   tool, and run one approved rollback of the staging demo app before anyone relies on
   `ops.rollback`.
4. Run a staging fix through the daemon deployed on Railway, the step #163 left open.
5. Give each teammate a personal token on staging, and move the demo repo to a bot account or a
   GitHub App with one required approval, which [docs/demo-repo.md](../demo-repo.md) says would
   close the token gap.
