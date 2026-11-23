# System: node daemon, sandbox, tiered toolkit and demo app

This section covers the part of PageAgents that runs a fix: the node daemon that claims a fix
job, the sandbox its commands run in, `execute()` and the tier policy every command passes,
the host tools at Tier 2 and Tier 3, and the demo app the seeded bugs break. Ingest, triage,
the agent loop and the dashboard have sections of their own.

## The node daemon

The daemon (`apps/node`) connects to the orchestrator's Postgres and claims jobs from the
pg-boss `fix` queue. It holds the model key, the GitHub token and the ops secrets, runs the
agent loop itself, and sends each command the agent asks for into the run's sandbox
([`apps/node/README.md`](../../apps/node/README.md)). It needs no open port: it connects out
to the orchestrator over Socket.IO.

```
orchestrator                    node daemon                              sandbox
------------                    -----------                              -------
pg-boss fix job  --- claim ---> runFixJob
                                  start the run's sandbox -------------> container, no network
                                  runAgent: model call (OpenRouter)
                                    execute(): parse, tier check,
                                    approval (Tier 3 changes),
                                    steps row, then run --------------> docker exec
                                                                         or su-exec (local)
                                    host tools: GitHub, ops API, Railway
/node socket     <-- node.step ---  each step once its row is written
                                  on submit: git diff, git status,
                                  scoreRun
                                  close the PR / undo ops changes
                                  if the run didn't succeed
run_finished job <-- result -----
/node socket     <-- node.run.finished
                                  remove the sandbox, release the live app
```

### Claiming a job

The orchestrator creates the `fix` queue with no retries, a 20 minute expiry and a
`fix_failed` dead letter queue. Each fingerprint has at most one open job, and every tier
shares the queue ([ADR 0003](../adr/0003-pg-boss-over-redis.md)). The daemon only works the
queue, so it never disagrees with the orchestrator on the queue's options. It parses each job
against the shared contract and refuses one whose run id isn't its pg-boss job id
([`job-source.ts`](../../apps/node/src/jobs/job-source.ts)). It takes one job at a time. A job
with no error report fails at once, before any container starts.

In the first staging end-to-end run (2026-11-19), a local daemon worked against the Railway
orchestrator and its database. Each claim took under 4 seconds, and the three Tier 1 fixes took
2m29s to 4m16s ([eval/README.md](../../eval/README.md)).

### Running and ending a run

`runFixJob` ([`run-fix-job.ts`](../../apps/node/src/run/run-fix-job.ts)) starts the run's
sandbox and runs `runAgent` with the tier's budget. The container's 15 minute clock starts
when it does, so the agent's 14 minute wall clock is cut by however long the sandbox took to
start. Every step goes to the `steps` table, and only then out on the socket as `node.step`.

A run ends in one of a few ways ([`outcome.ts`](../../apps/node/src/run/outcome.ts)):

| End                                                         | Status      | What the orchestrator does                  |
| ----------------------------------------------------------- | ----------- | ------------------------------------------- |
| Submitted, score at or over the tier's threshold            | `succeeded` | Waits for approval, or resolves if ops-only |
| Submitted, score under the threshold, Tier 1 or 2           | `escalated` | Queues the next tier (`low_confidence`)     |
| Out of steps, cost or time, Tier 1 or 2                     | `escalated` | Queues the next tier (`budget_exhausted`)   |
| Either of the two above at Tier 3                           | `failed`    | Fails the issue; a person takes over        |
| Killed                                                      | `killed`    | Kills the issue                             |
| No report, no sandbox, a daemon error or a job expiry       | `failed`    | Fails the issue: a higher tier won't help   |
| The agent stopped on bad replies, a model or an audit error | `failed`    | Fails the issue: a higher tier won't help   |

Every end sends the result twice: `node.run.finished` on the socket for the dashboard, and a
`run_finished` job with the run's times and diff, which the orchestrator records it from. The
job is the record and the socket is best effort (#136). A result that can't be queued after 3
tries fails the fix job, and so does a daemon that dies mid-run once the job expires. Either
way pg-boss moves the job to `fix_failed` and the orchestrator fails the issue.

A run that doesn't succeed cleans up after itself before its result is queued. It closes any PR
it opened, with a comment saying why, so the tier above doesn't open a second one beside it. At
Tier 3 it also puts back the settings it changed. A submitted patch that scored too low counts
as not succeeding here too, but its diff stays on the run's record for a reviewer.

## The sandbox

ADR 0001 sets the policy: no network in the container, and the agent loop in the daemon so the
keys never enter it ([ADR 0001](../adr/0001-sandbox-network-policy.md)). The daemon has two
runtimes for it, chosen by `SANDBOX_RUNTIME`.

### Docker, the default

Each run gets its own container from the sandbox image (`infra/sandbox/Dockerfile`), with these
flags ([`run-args.ts`](../../apps/node/src/sandbox/run-args.ts)):

| Limit          | Value                                                |
| -------------- | ---------------------------------------------------- |
| Network        | `--network none`                                     |
| CPU and memory | 1 CPU, 1 GB with no swap                             |
| Processes      | 256                                                  |
| Privileges     | `--cap-drop ALL`, `no-new-privileges`                |
| Writable       | `/workspace` (the repo) and a 128 MB `/tmp`          |
| Wall clock     | The main process is `sleep 900`, so it stops on time |
| Label          | `page.sandbox`, so the daemon can find strays        |

The image bakes in the demo app with its full dependency tree, pnpm, git and ripgrep, so tests,
lint and typecheck run offline. It commits the baked-in source as a baseline, so the agent's
diff is everything after that commit. The root filesystem isn't read-only. A writable volume
for the repo would copy about 540 MB of `node_modules` on every start (3.5 to 6 s, against 0.35
s without), so file ownership keeps the sandbox user out of everything but `/workspace` and
`/tmp`, and `infra/sandbox/smoke.sh` fails if anything else is writable. PGlite needs V8's
baseline compiler (`--liftoff-only`) to start inside 1 GB, and the demo app's unit suite takes
about 40 s on one CPU. The image is rebuilt and republished whenever `apps/demo-app` changes.

Commands run with `docker exec` under a `timeout -s KILL` inside the container. Afterwards the
runner kills whatever the command left in its session or tagged with its id, so a stray
background process can't hold the output open or eat the sandbox's CPU and pids
([`wrapped-runner.ts`](../../packages/toolkit/src/exec/wrapped-runner.ts)). Each command gets
at most 5 minutes, and never more than the run has left.

### Local, for hosts without Docker

Railway, where staging runs, can't start containers from inside one. `SANDBOX_RUNTIME=local`
runs the daemon and one sandbox in a single container instead (`apps/node/Dockerfile`, #163).
`/workspace` holds page-demo at a set ref with its dependencies installed. The daemon runs as
root. Each command runs as an unprivileged `sandbox` user through `su-exec` and `env -i`, so it
starts with none of the daemon's variables and can't read root's `/proc/<pid>/environ`. The
same 256-process limit applies, as `ulimit -u`, with the same timeout and cleanup
([`local-sandboxes.ts`](../../apps/node/src/sandbox/local-sandboxes.ts)). There is one
workspace, so one run at a time, and each start kills the user's processes and resets
`/workspace` to its baseline commit.

ADR 0001's amendment lists what this gives up. Commands have the container's network, because
blocking it needs privileges Railway doesn't grant. The command policy still refuses `curl` and
`wget`, but `node -e "fetch(...)"` can reach the internet; the keys it would want aren't in its
reach. CPU and memory are the container's, shared with the daemon, so a command that exhausts
memory can take the daemon down with it. And if the daemon dies, nothing stops the run's
processes until the next start. The ADR says to use `docker` wherever the host allows it.

## execute(), the tier policy and the audit log

Every command, edit and host tool call the agent makes goes through one function, `execute()`
in `@page/toolkit` ([`execute.ts`](../../packages/toolkit/src/exec/execute.ts)). It checks the
call against the tier's policy, asks for approval if the call needs it, writes the step, runs
the call and trims its output to 8,000 characters, keeping the head and the tail.

### The policy

A shell command first goes through a small parser for the subset of POSIX `sh` the agent may
use ([`parse.ts`](../../packages/toolkit/src/shell/parse.ts)). Anything it can't reason about
(expansion, substitution, subshells, heredocs, globs, background jobs) is refused, so a blocked
command can't hide inside an allowed one. What it accepts runs under `sh -c` exactly as parsed.
Every command in the line then has to pass
([`policy.ts`](../../packages/toolkit/src/policy/policy.ts)):

- Blocked at every tier: `sudo`, `su`, `doas`, `curl`, `wget`, `docker`, force pushes,
  environment assignments, and a program run by path.
- The allowlist: `cat`, `ls`, `head`, `tail`, `rg` without `--pre`, `find` without its actions
  that run, write or delete, `git status`, `git diff` and `git log`, and `pnpm` for test, lint,
  typecheck, `vitest`, `tsc` and `eslint`. `pnpm` flags that would make a run with no tests
  exit 0 are refused (#65, #66), and so are output paths outside the repo.
- Writes, by redirect or by the edit tool, may not leave `/workspace`, use `..`, or land under
  `.git/`, `.github/` or `node_modules/` ([`paths.ts`](../../packages/toolkit/src/policy/paths.ts)).
  `.git/` config could make `git status` run any program, and `node_modules/` holds symlinks
  that point anywhere.

The shell allowlist is the same at every tier. Tiers differ only in the host tools, which run
in the daemon rather than the sandbox and each have a lowest tier (`HOST_TOOL_TIERS`): the
GitHub tools from Tier 2 and the ops tools at Tier 3. A refusal comes back as text the agent
can read and act on.

The policy's own comments say it is not the boundary. `pnpm test` runs the repo's scripts,
configs and test files, and the agent can change any of them with the edit tool. The policy
keeps an honest agent from writing outside the repo or misreading a test run, and the sandbox
holds the rest.

### The audit log

Every `execute()` call is one row in `steps`, refusals included (`allowed = false`). An allowed
call's row is written before it runs, so if that write fails the call doesn't run, and
`execute()` returns `audit_failed`. If the write after it fails, the call returns `audit_failed`
with what the command did. Log lines carry the issue, run and tier, and keep a trimmed command,
or an edit's path and text lengths but not its text (#4). The eval's unsafe attempts metric is
the refused rows per 100 steps, which is complete because nothing runs unrecorded
([evaluation-method.md](evaluation-method.md#metrics)).

## Tier 2: pushing a branch and opening a PR

From Tier 2 the agent has `git.pushBranch` and `github.openPr` (#10). The sandbox has no
network and the token stays on the host, so the push doesn't use git. The daemon reads the
agent's changes out of the container (`git status`, then `stat` and `base64` for each file) and
commits them through GitHub's API to `pageagents/<runId>` on the demo repo, over `main`. Each
push builds the whole change again, so a second push fast-forwards the branch. The PR names the
issue and the run, and when a lower tier gave up, its body says why. The daemon refuses to push
a path the edit tool would refuse, and symlinks. Both the adapter and the repo's rulesets refuse
a branch outside `pageagents/` ([docs/demo-repo.md](../demo-repo.md)).

The sandbox's workspace has to match the demo repo's `main`, since paths and contents are copied
across as they are. For a live demo the bug sits in both: `infra/sandbox/demo.Dockerfile` folds
a scenario's `break.sh` into the sandbox's baseline commit, and `demo-sync.sh` opens a PR that
puts page-demo `main` on the same tree (#125).

## Tier 3: ops tools, rollback and approvals

### Ops tools

A Tier 3 run gets four tools on the live demo app's ops API (#147, #157): read the settings
(`ops.getConfig`), set or drop a runtime override (`ops.setConfig`, `ops.deleteConfig`), and
restart the app (`ops.restart`), at most 3 times a run, since each restart drops requests in
flight. They call `OPS_APP_URL` with `OPS_SECRET` as a bearer token. The URL must be https, or
plain http on loopback only. The daemon reads its own variable rather than `DEMO_APP_URL`, which
`.env` keeps for staging's app, so a local daemon changes staging only if someone points it
there (#157).

A Tier 3 run claims the app for its whole run, so two runs can't change and restart it under
each other. The claim is a Postgres advisory lock keyed on the app's URL, which every daemon on
the same database sees, plus the lock directory `pnpm eval:run` takes on the same machine.
While someone else holds the app, each ops call is refused and the agent can escalate. An eval
on another machine doesn't see the claim.

### Rollback

With the Railway service behind `OPS_APP_URL` configured, a Tier 3 run also gets
`ops.planRollback`, a dry run that shows the live deployment and the earlier one a rollback
would deploy again, and `ops.rollback`, which sends it and waits until the new deployment is
live or has failed (#172). Each limit has a reason:

- One rollback a run. If a run needs a second, the first was the wrong call.
- `ops.rollback` takes only the target of the run's last plan, so the agent has seen what goes
  live and the step log shows the same target.
- If another deployment went live after the plan, the rollback is refused (`live_changed`).
- Nothing while a build or deploy is in flight, since it would go live after the rollback and
  undo it.
- The target must have served traffic before, Railway must still hold its image, and by default
  every build of the live commit is skipped.

The Railway token is a project token for one environment. Its variable names are not Railway's
own `RAILWAY_*` names, because Railway sets those on every service it runs, and a daemon on
Railway would read its own service and roll itself back. The rollback tool has run only against
a fake deployer; the Railway GraphQL fields are checked against Railway's docs and a faked
fetch, and #172 names `ops.planRollback` against staging as the first live check to make.

### Approvals

`ops.setConfig`, `ops.deleteConfig`, `ops.restart` and `ops.rollback` wait for a person before
they run (`APPROVAL_TOOLS`, #176). The reads and the Tier 2 tools are not gated. Gating the
restart alone would not be enough: an override sits in the app's store and loads on any restart,
a crash or someone else's included, so it is approved where it is made, with the key and value
in view ([`approval.ts`](../../packages/toolkit/src/exec/approval.ts)).

`execute()` asks after the tier check and before the step opens. The daemon sends
`node.approval.request` with the tool, its arguments and a deadline. A rollback's request also
names the live deployment and the one it would deploy. The orchestrator shows it on the incident
page and answers with `approval.decided`
([`approvals.ts`](../../apps/node/src/run/approvals.ts)).

| Answer                       | What the run sees                                                      |
| ---------------------------- | ---------------------------------------------------------------------- |
| Approved                     | The tool runs with what is left of the command's time limit            |
| Rejected                     | A refusal, read like a policy refusal: try something else or escalate  |
| No answer by the deadline    | The orchestrator rejects it; 10 s later, the daemon counts it rejected |
| Kill or expiry while waiting | The wait ends as a refusal and the run reports `killed`                |

The deadline is at most 3 minutes away, and never later than the command or the run may last.
The run's wall clock keeps running while it waits. After a dropped socket, the daemon sends
every request still waiting again with the same id, and the orchestrator answers one decided
meanwhile with its decision. A daemon with no way to ask refuses every gated call.
`AUTO_APPROVE_OPS` approves without asking, and the config takes it only with fake adapters or a
local app with no Railway settings. The eval approves every gated call itself, since no one
watches its runs.

### Undo after a run that fails

A Tier 3 run that doesn't succeed puts back each override it changed, and restarts the app if it
had restarted it after a change, so the app is back as the run found it (#157). It is best
effort and logged. A change whose request never answered may have landed and is left as it is.
A rollback is kept, not rolled forward: that would deploy again the build the run judged bad,
with no one deciding to, and once a person approved the rollback it would undo their decision
(#172). Undo is not gated, since it only puts back changes already approved.

### Ops-only fixes

A Tier 3 run that succeeds keeps its ops changes. If it changed the live app, opened no PR, and
`git status` shows the workspace as it started, new files included, its result says
`opsOnly: true` and the orchestrator resolves the issue: the fix is live and there is no patch
to approve (#161). The daemon asks `git status` because a null diff can also mean one it
couldn't read or one over the cap, and `git diff` leaves out new files. Anything it can't
confirm reports `opsOnly: false`, and the run goes to review.

## Kill, cleanup and the /node link

The daemon keeps an abort controller for each run it holds (#84). `run.kill` from the
orchestrator aborts it. That removes the sandbox at once, which ends any running command, and
cancels the model call in flight. The run then finishes as `killed` with a note of what it
tried. A job expiry stops a run the same way, and the run fails as expired. A kill for a run the
daemon isn't holding is logged and ignored. In the Docker integration test a kill mid-command
and a kill mid-model-call each finished in under 5 seconds with no container left.

At startup, before it claims anything, the daemon removes every container labelled
`page.sandbox` that a crashed daemon left behind; the local runtime resets its workspace
instead. This assumes one daemon per Docker host. On SIGTERM the daemon stops claiming and
waits for the runs in hand rather than aborting them, which would report a restart as a kill
and drop the job.

The link to the orchestrator is a Socket.IO client on the `/node` namespace
([`socket-io-link.ts`](../../apps/node/src/link/socket-io-link.ts), #173). The handshake carries
`NODE_SHARED_SECRET` and the daemon's name, which the dashboard's agents page lists it by. The
orchestrator relays `node.step`, `node.diff` and `node.run.finished` to the dashboard and writes
none of it, since the daemon has already written each step. It tracks which socket last named
each run, and sends `run.kill` there; for a run it has no socket for, the kill reaches the daemon
on its next event for that run. socket.io-client reconnects by itself after a dropped connection
and sends what it buffered. It gives up after a refused handshake or a socket the server closed,
so the link tries again itself, a minute after a refusal and 5 seconds after a close. The
orchestrator limits each address to 30 handshakes a minute and each socket to 300 messages
every 10 seconds.

## Confidence from the node's side

Once the agent submits, the daemon scores the run with `scoreRun` from `@page/agent` (#174). It
asks no model. It reads the run's steps, as recorded, and the files `git status` shows changed
([`confidence.ts`](../../packages/agent/src/confidence.ts)):

| Part              | Holds when                                                                      | Weight |
| ----------------- | ------------------------------------------------------------------------------- | -----: |
| `testsPass`       | After the last edit, a test run passed and none failed                          |    0.5 |
| `checksPass`      | After the last edit, a typecheck or lint passed and none failed                 |    0.3 |
| `reproduced`      | Before the first edit to code, a test run failed                                |    0.2 |
| `changesCode`     | A changed file isn't a test. False scores 0: nothing changed, or only tests     |        |
| `liveAfterChange` | Ops-only fixes: a healthy restart or a live rollback came after the last change |        |

An ops-only fix scores 1 when `liveAfterChange` holds and 0 when it doesn't. A score under the
tier's `CONFIDENCE_THRESHOLD`, 0.2 at every tier, sends the run on as `low_confidence`, or fails
it at Tier 3 ([`threshold.ts`](../../packages/agent/src/threshold.ts)). At 0.2, a code fix
escalates only when it scores 0: it changed no code, or no test, typecheck or lint passed after
its last edit and no test failed before its first code edit. The value comes from a dev-only
calibration (Amendment 5 in [the preregistration](eval-prereg.md)). A run whose scoring threw has no score and never escalates for want of one.

#174 gives the reasons for measured signals over asking a model. The failure the score is after
is a confident wrong patch, and the model that wrote the patch would most likely give a
confident answer in exactly those cases. A model call would also add cost, latency and another
place for text from a production error to act as instructions. `scoreRun` reads only exit
codes, summary lines and paths. The weights and the threshold are a judgment call: every run in
the Results came before scoring, and Amendment 5 of the [preregistration](eval-prereg.md) sets
out a dev run to calibrate the threshold.

## The demo app and the seeded bugs

The demo app (`apps/demo-app`) is a Next.js and Postgres shop with products, a cart, checkout and
a JSON API (#1). It plays production. Seeded bugs break it on four surfaces: pages, the `/api/*`
route handlers, SQL and constraints, and the env settings in `src/config.ts`
([`apps/demo-app/README.md`](../../apps/demo-app/README.md)). Its unit tests run on PGlite, an
in-memory Postgres, so they pass inside the sandbox with no network.

It reports every unhandled server error through Next.js's `onRequestError`, and browser errors
through posthog-js, tagged with the route, the release and the error name (#2). Both go through
an `ErrorReporter` with an in-memory fake when `POSTHOG_KEY` is unset. A `ShopError` handled as a
4xx isn't reported; one that escapes is a 500 like any other crash.

For Tier 3 it has an ops API behind a bearer secret (#13). Settings live in env, and rows in a
`runtime_config` table override them. The app reads the overrides once per process, so a change
applies on restart. `GET`, `PUT` and `DELETE /api/ops/config` read, set and drop an override,
and `POST /api/ops/restart` answers 202 and exits so Railway's restart policy brings the app
back, or 409 if the next settings won't parse. Every call takes `?dryRun=true`. None of it goes
through the shop's own settings, so a bad setting can't lock it out. Rollback is not in the app:
it never holds a Railway token, and a broken app has to be rolled back from outside.

The 30 scenarios in `scenarios/` break the app in two ways
([`scenarios/README.md`](../../scenarios/README.md)). A code scenario's `break.sh` edits a clean
demo app in the sandbox image and fails if the code it edits has moved. 27 of the 30 are code
bugs. The three ops scenarios break the running app instead: 029 and 030 plant a bad
`SHIPPING_FLAT_CENTS` override through the ops API, which validates every value, so the planted
one is valid but wrong and makes checkout throw. 024 deploys a build that isn't on `main`, with
a compose stand-in for Railway, and its fix is a rollback. Each scenario's `trigger.sh` makes the
bug fire on a running app so PostHog records it, and its `meta.json` holds the report the agent
gets, capped at 2,000 characters (#139). The scenario format, the hidden check, the self-test and
the class and tier spread are in [evaluation-method.md](evaluation-method.md#scenarios).
