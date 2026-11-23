# @page/node

The daemon that runs fix jobs (#8). It claims a job from the orchestrator's `fix` queue,
starts one sandbox container for the run, runs the agent loop on the host, and sends each
command into the container through toolkit's `execute()`. Every step is written to the
`steps` table, then streamed to the orchestrator as `node.step`. When the run ends it sends
`node.diff` (after a submit) and `node.run.finished` on the socket, queues the same result
with the run's times and diff as a `run_finished` job, and removes the container. The job
is the record the orchestrator moves the issue from (#136); the socket is best effort.

```
pg-boss `fix` queue -> PgBossJobSource -> runFixJob -> DockerSandboxes (one container per run)
                                              |-> runAgent -> execute() -> docker exec
                                              |-> PostgresAuditSink -> steps table
                                              |-> PgBossRunResults -> pg-boss `run_finished` queue
                                              '-> SocketIoLink -> orchestrator /node namespace
```

## Run it locally

```sh
pnpm db:up
docker build -f infra/sandbox/Dockerfile -t page-sandbox .   # only with real adapters
pnpm --filter @page/node start
```

`start` reads `../../.env` if it exists. The variables come from `nodeConfigSchema` in
`packages/contracts/src/config.ts`:

| Var                           | Default        | Notes                                   |
| ----------------------------- | -------------- | --------------------------------------- |
| `DATABASE_URL`                |                | Same database as the orchestrator       |
| `PGBOSS_SCHEMA`               | `pgboss`       | Must match the orchestrator's           |
| `ORCHESTRATOR_URL`            |                | The daemon connects out to `<url>/node` |
| `NODE_SHARED_SECRET`          |                | Sent as `auth.token` in the handshake   |
| `NODE_NAME`                   | the hostname   | Sent as `auth.name`; names it in the UI |
| `SANDBOX_IMAGE`               | `page-sandbox` | Built from `infra/sandbox/Dockerfile`   |
| `SANDBOX_RUNTIME`             | `docker`       | `local` on hosts without Docker (below) |
| `OPENROUTER_API_KEY`          |                | Required unless `USE_FAKE_ADAPTERS`     |
| `OPENROUTER_MODEL`            |                | Required unless `USE_FAKE_ADAPTERS`     |
| `GITHUB_TOKEN`, `GITHUB_REPO` |                | Required unless fakes; Tier 2 tools     |
| `OPS_APP_URL`                 |                | Optional; the app for Tier 3 ops tools  |
| `OPS_SECRET`                  |                | That app's ops secret; needs 32+ chars  |
| `OPS_RAILWAY_*` (four)        |                | Optional; that app's Railway service    |
| `AUTO_APPROVE_OPS`            | `false`        | Fakes or a local app only; see below    |
| `USE_FAKE_ADAPTERS`           | `false`        | See below                               |
| `LOG_LEVEL`                   | `info`         |                                         |

With `USE_FAKE_ADAPTERS=true` there is no Docker, model, GitHub or socket. Each run gets a
fake sandbox with one changed file whose commands exit 0, a scripted model that runs the
tests and submits (which scores 0.5, so the run succeeds), an in-memory GitHub, an
in-memory ops API, an in-memory deployer with a deploy to roll back to, and a link that logs
events instead of sending them. Postgres stays real, so steps still land in the `steps`
table.

Two things have to exist before a job will run:

- The `fix` queue. The orchestrator creates it at boot; until it has, the daemon logs
  `Queue fix does not exist` and keeps polling.
- The `steps` table. The orchestrator creates it at boot too, from
  `packages/db-migrations/migrations/002_runs.sql`.

Fix jobs need a `report` (the triaged error report). A job without one fails at once with
a note saying so, and no container starts.

## On a host without Docker (Railway)

`apps/node/Dockerfile` builds the daemon with its sandbox inside: `/workspace` holds
page-demo at `PAGE_DEMO_REF` (default `main`) with its dependencies installed, and the
image sets `SANDBOX_RUNTIME=local`. Each command runs as the unprivileged `sandbox` user,
with none of the daemon's variables, one run at a time. Commands can reach the network, and
CPU and memory are the container's rather than per run. ADR 0001's amendment lists what
holds and what doesn't, so prefer `docker` where the host can run containers.

```sh
docker build -f apps/node/Dockerfile -t page-node .
```

The workspace must hold the tree the deployed demo app runs, or the agent's diff carries
more than the fix. Railway's demo app builds page-demo `main`, so redeploy the node service
after a `demo-sync.sh` PR merges there.

On Railway the service builds that Dockerfile from the repo root
(`RAILWAY_DOCKERFILE_PATH=apps/node/Dockerfile`) with no public domain, and takes the
variables above: `DATABASE_URL` from the `db` service, `ORCHESTRATOR_URL` and
`NODE_SHARED_SECRET` from the orchestrator, and `OPS_APP_URL` and `OPS_SECRET` for the demo
app, with the `OPS_RAILWAY_*` vars for its service if Tier 3 may roll it back. It needs no
port. Give it a `NODE_NAME` too: its hostname changes with each deploy, and the agents page
would list each deploy as a new daemon.

## Tier 2: pushing the fix and opening a PR

From Tier 2 the agent can call two host tools, `git.pushBranch` (a `page_push_branch`
block) and `github.openPr` (`page_open_pr`). They run in the daemon, not the sandbox,
because the sandbox has no network and the token stays on the host. At Tier 1 both are
refused, and the refusal is a `host_tool` step like any other.

The push doesn't use git. The daemon reads the agent's changes out of the container
(`git status`, then `stat` and `base64` for each file) and commits them through GitHub's
API to `pageagents/<runId>` on `GITHUB_REPO`, over `main`. Each push builds the whole
change over `main` again, so a second push fast-forwards the branch. The PR names the issue
and run, and `node.run.finished` carries its URL as `prUrl`.

The sandbox workspace has to match the demo repo's `main`, since paths and contents are
copied across as they are. Setting up the repo and the token is in
[`docs/demo-repo.md`](../../docs/demo-repo.md).

## Tier 3: the live app's ops tools

Tier 3 runs also get the ops tools on the live demo app: `ops.getConfig`
(`page_ops_config`), `ops.setConfig` (`page_ops_set`), `ops.deleteConfig`
(`page_ops_unset`) and `ops.restart` (`page_ops_restart`), at most 3 restarts a run. They
call the app's ops API at `OPS_APP_URL` with `OPS_SECRET` as the bearer token, so set
`OPS_SECRET` to the app's own value (32 characters or more, surrounding spaces trimmed).
`OPS_APP_URL` must be https, or plain http for `localhost`, `127.0.0.1` or `[::1]` only,
and takes no user, password, query or fragment. Runs below Tier 3 are never given the
tools. A job expiry or a kill aborts the agent's request in flight and stops any further
one.

A Tier 3 run claims the app before it starts, and holds it until it finishes, so two runs
can't change and restart the app under each other. The claim is a Postgres advisory lock
keyed on `OPS_APP_URL`, which every daemon on the same database sees, plus the lock
directory `pnpm eval:run` takes on this machine. While someone else holds the app, each ops
call is refused with `the live app is in use by another run or eval`, and the agent can
escalate. A daemon killed outright leaves that directory behind, which then refuses every
Tier 3 run on the machine; the warning logs its path (`lockDir`), so remove it once nothing
is using the app. An eval on another machine doesn't see the claim, so don't run one
against an app a daemon is using.

A Tier 3 run that doesn't succeed (it fails, expires, is killed, or submits a fix that
scores under the confidence threshold) puts back each override it changed, and restarts the
app if it restarted it after a change, so whoever takes the issue next finds the app as this
run found it. These requests go out after the run has stopped, kill included, and before its
result is queued. It is best effort, like closing the PR of a run that didn't succeed: it
tries every setting and the restart, and logs each one the app wouldn't take. A change whose
request never answered, say because a kill cut it off, may have landed, and is logged by name
and left as it is.

A Tier 3 run that succeeds keeps its ops changes. If it changed the live app (an override it
didn't set back, or a restart after a change), opened no PR, and `git status` shows the
workspace as it started, new files included, its result says `opsOnly: true` and the
orchestrator resolves the issue: the fix is live already and there is no patch to approve.
The daemon asks `git status` because a null diff in the result also means one it couldn't
read or one over the cap, and `git diff` leaves out new files. Anything it can't confirm,
`git status` failing included, reports `opsOnly: false`, and the run goes to review.

Without `OPS_APP_URL` the daemon logs once at startup that Tier 3 runs get no ops tools, and
every ops call is refused as `not set up on this node`. The daemon never reads
`DEMO_APP_URL`, which `.env` keeps for staging's app, so a local daemon changes staging only
if `OPS_APP_URL` names it.

## Tier 3: rolling back a bad deploy

With the Railway service behind `OPS_APP_URL` set, Tier 3 runs also get two rollback tools,
built on `rollback()` and `RailwayDeployer` in `@page/toolkit`:

- `ops.planRollback` (`page_ops_rollback_plan`): a dry run. It shows the live deployment and
  the earlier one a rollback would deploy again, with each one's commit and creation time.
  It deploys nothing.
- `ops.rollback` (`page_ops_rollback`, holding a deployment id): deploys that earlier build
  again, then asks Railway every 3 seconds until the new deployment is live or has failed,
  within the command's time limit.

The limits, and why:

- One rollback a run. A rollback replaces the whole live build. If a run needs a second
  one, the first was the wrong call, and what to deploy next is a person's decision.
- Plan first. `ops.rollback` takes only the target of the run's last plan, so the agent has
  seen what goes live before it sends anything, and the step log shows the same target. A
  plan is spent once a rollback is sent.
- The plan must still hold. If another deployment went live after the plan, the rollback is
  refused (`live_changed`), so it can't replace a deploy the agent never saw.
- Nothing while a deploy is in flight. A build or deploy newer than the live one would go
  live after the rollback and undo it, so `rollback()` refuses.
- The target served traffic before (`REMOVED`) and Railway still holds its image
  (`canRollback`). By default `rollback()` skips every build of the live commit, so a second
  rollback can't land on the build the first one left.

A refused call sends nothing and doesn't use up the run's rollback. A rollback Railway took
counts as a change to the live app, so a run that submits after one, with no PR and no code
change, reports `opsOnly: true` like a settings fix.

A run that ends without submitting keeps its rollback, while its override changes are put
back as above. The daemon logs the rollback instead. Rolling forward would deploy again the
build the run judged bad, with no one deciding to, and it is a deploy of its own that can
fail or drop requests. The rollback's target is a build that served traffic before. Once a
person approves Tier 3 tools, a roll forward would also undo their decision. A rollback
whose request never answered may have started, and is logged and left as it is too.

`OPS_RAILWAY_TOKEN` is a project token for the service's environment, sent as
`Project-Access-Token`, so it can't reach another environment. `OPS_RAILWAY_PROJECT_ID`,
`OPS_RAILWAY_ENVIRONMENT_ID` and `OPS_RAILWAY_SERVICE_ID` are UUIDs. Boot fails on part of
the set, on an id that isn't a UUID, or on the set without `OPS_APP_URL`, since the run
claims the app it rolls back by that URL. The names aren't Railway's own `RAILWAY_TOKEN` and
`RAILWAY_*_ID`, because Railway sets those on every service it runs: a daemon on Railway would
read its own service and roll itself back. Without the set, a daemon with ops tools logs
once at startup that Tier 3 runs get no rollback tool, the prompt leaves the rollback blocks
out, and a rollback call is refused as `not set up on this node`.

## Confidence

Once the agent submits, the daemon scores the run with `scoreRun` from `@page/agent` and
sends the score as `confidence` on the result. It asks no model. It reads the run's steps and
the files `git status` shows changed:

| Part              | Holds when                                                                      | Weight |
| ----------------- | ------------------------------------------------------------------------------- | -----: |
| `testsPass`       | After the last edit, a test run passed and none failed                          |    0.5 |
| `checksPass`      | After the last edit, a typecheck or lint passed and none failed                 |    0.3 |
| `reproduced`      | Before the first edit to code, a test run failed                                |    0.2 |
| `changesCode`     | A changed file isn't a test. False scores 0: nothing changed, or only tests     |        |
| `liveAfterChange` | Ops-only fixes: a healthy restart or a live rollback came after the last change |        |

An ops-only fix changed no code, so it scores 1 when `liveAfterChange` holds and 0 when it
doesn't. A test or check run counts by its exit code. A command with a pipe exits with its
last part (`sh -c` has no pipefail), so for one of those only Vitest's summary line says
whether the tests passed. Steps that were refused, and test paths that matched no file,
don't count.

A score under the tier's `CONFIDENCE_THRESHOLD` (`packages/agent/src/threshold.ts`, 0.2 at
every tier, calibrated on dev bugs under Amendment 5 of `docs/report/eval-prereg.md`) sends the run on as `escalated` with reason `low_confidence`, or as `failed` at
Tier 3. The note says what was missing, the patch stays on the run's record, a PR the run
opened is closed, and its ops changes are put back, as for any run that doesn't succeed. A
run the daemon couldn't score, because scoring threw or the daemon predates it, has
`confidence: null` and never escalates for want of a score.

## Tier 3: a person approves each change to the live app

`ops.setConfig`, `ops.deleteConfig`, `ops.restart` and `ops.rollback` wait for a person's
approval before they run (`APPROVAL_TOOLS` in `@page/toolkit`). A restart drops requests in
flight and loads any staged override, and a rollback replaces the live build. A setting
change only loads on the next restart, but that can be any restart (a crash, a redeploy,
someone else's), so it is approved where it is made, with its key and value in view. The
reads, `ops.getConfig` and `ops.planRollback`, are not gated, and neither are the Tier 2
GitHub tools, which only reach the run's own branch and PR.

`execute()` asks after the tier check and before the step opens. The daemon sends
`node.approval.request` with the tool, its arguments (a rollback also names the live
deployment and the one it would deploy, from the run's last plan), `expiresAt` and `reason`,
and waits for the `approval.decided` that answers it. The orchestrator shows the request on the
incident page.

`reason` is the model's THOUGHT for the step that asked, so the person sees why the agent
wants the call. `approvalReason` in `@page/contracts` drops control characters and
bidirectional marks, trims it and clips it to 1,000 characters (`MAX_APPROVAL_REASON_CHARS`);
it is null when the model wrote none. It is the model's text, and the model read an error
report anyone could have shaped, so the incident page shows it as plain text, labeled as the
agent's own words.

The agent knows its changes wait. When a person answers (`LinkApprovals`) and the run has a
gated tool, the Tier 3 task prompt gets a "Changes a person approves" section: which blocks
wait, that the person reads the THOUGHT before the block, that a wait can take a few minutes of
the run's time, to read the settings first and restart once after its last change, and that a
rejection or no answer comes back refused. Then it shouldn't ask for the same change again: it
tries another fix, or submits so the run goes to a person. With `AUTO_APPROVE_OPS`, in the eval,
on a node with no ops API and below Tier 3, the prompt has no such section.
`packages/agent/src/eval-prompt.test.ts` pins the prompts an auto-approved run sees to hashes
of the ones the recorded eval runs used.

- **Approved**: the tool runs with what is left of the command's time limit.
- **Rejected**: the step is a refusal, `refused: ops.restart was not approved: arjun
rejected it`, and the agent reads it like a policy refusal, so it can try something else or
  escalate.
- **No answer**: the wait lasts at most 3 minutes (`APPROVAL_TIMEOUT_MS`), and no longer than
  the command may take, which is no longer than the run has left. The run's wall clock keeps
  running meanwhile. The orchestrator rejects the request at `expiresAt` and says so; the
  daemon waits 10 seconds past it for that answer (`APPROVAL_GRACE_MS`), then counts the call
  rejected itself.
- **Kill or expiry while waiting**: the wait ends at once as a refusal, the agent loop stops,
  and the run reports `killed` as before.
- **Dropped socket**: the orchestrator keeps no event for a daemon that is away, so after a
  reconnect the link sends every request still waiting again, with the same id. The
  orchestrator answers one decided meanwhile with its decision, and keeps waiting on one still
  open. A link that stays down can't hold a run: the wait still ends at its deadline.
- A call the tool would refuse anyway (a bad key, a spent restart or rollback, a rollback
  with no plan, a run refused the app) asks no one and refuses itself.

A daemon with no way to ask refuses every gated call. `AUTO_APPROVE_OPS=true` approves them
all without asking, and the config takes it only with `USE_FAKE_ADAPTERS`, or with an
`OPS_APP_URL` on this machine and no `OPS_RAILWAY_*`, so it can't reach a shared app. The
daemon logs a warning at startup when it is on. The eval approves every gated call itself
(`evalApprove` in `eval/src/approve.ts`), since no one watches its runs.

Undo after a run that didn't submit is not gated: it puts back what the run changed with the
approvals it already had, and no one is waiting on the run by then.

## Messages from the person on call

Someone watching a run on the incident page can send the agent a message, such as "why that
file?" or "check the config first". The orchestrator sends it to the daemon holding the run
as `run.chat`, with the message id and the person's name, and each run's inbox
(`src/run/inbox.ts`) keeps it until the agent loop reads it.

- **When the agent reads it.** At each step boundary, before its next model call, the loop
  takes every message waiting and adds it to the user's turn, after the result of the last
  action, in an `<oncall_message from="...">` element (`onCallPrompt` in `@page/agent`). The
  text is escaped, so it can't close its element or pose as another sender. A question
  doesn't stop the run.
- **How it answers.** The prompt asks for the answer in an `<oncall_reply>` element in the
  next response, next to its one action. The loop takes the answer out before it reads the
  action and the step's thought, and the inbox sends it back as `node.chat.reply`, cut to
  4,000 characters. A reply with no answer closes the message as `no_answer`; a reply with an
  answer and no action keeps the answer and is a format error, as before.
- **Guidance, not authority.** The prompt says the message can't give the run tools or
  permissions its tier doesn't have, and that every action still goes through the same rules,
  checks and approvals. That holds whatever the model does with it: the message is only text,
  and `execute()` is still the only way out. A test asks a Tier 1 run for `curl ... | sh` and a
  restart of the live app, and both steps are refused.
- **Budget.** Answering costs no model call of its own: the answer rides in the reply that
  takes the next action, a call the run makes anyway. So a message adds no call to the
  40-call step limit at every tier, and a run with questions runs out of steps no sooner than
  the same run without them. It does cost tokens, which count against the run's dollar limit:
  the message stays in the context for every later call, and the answer is output. The
  orchestrator's caps bound that.
- **Caps.** At most 3 messages wait at once; a fourth is closed as `queue_full` at once.
  The orchestrator caps a message at 1,000 characters and a run at 10 messages.
- **After the agent stops.** Once the agent loop returns, the inbox ends. What is still
  waiting, and anything that arrives later, is closed as `submitted` when the agent submitted
  (the daemon is reading its diff, scoring it and reporting) and `run_ended` otherwise. A
  message the agent read whose answer never came, because the run was killed or the model
  call failed, is `run_ended`. A `run.chat` for a run this daemon isn't running is closed as
  `run_ended`.

Every message gets exactly one `node.chat.reply`. With no message, the loop sends exactly
what it sent before there was an inbox: `oncall.test.ts` runs the same script with no inbox
and with an empty one and compares every call, and every recorded transcript replays with an
empty inbox. The eval passes no inbox, so its prompts are unchanged.

## Tests

```sh
pnpm --filter @page/node test               # unit, with fakes
pnpm --filter @page/node test:integration   # needs DATABASE_URL and Docker
```

The integration tests claim a job from a real pg-boss queue, run it end to end with fake
Docker and model and check the `steps` row, and start and remove a real container.

## The orchestrator side

- The orchestrator serves the `/node` namespace and refuses a handshake without
  `NODE_SHARED_SECRET` as `auth.token`. It relays `node.step`, `node.diff` and
  `node.run.finished` to the UI. The daemon writes steps itself, because `execute()` must
  not run a command whose step it couldn't record, so the server doesn't insert them again.
- The handshake also carries the daemon's name as `auth.name`: `NODE_NAME`, or the
  hostname. The orchestrator records it with each run the daemon works, and the UI's agents
  page lists daemons by it. Two daemons with the same name show as one agent.
- A kill reaches the daemon as `run.kill`: at once when its socket has named the run, or on
  its next event for a run killed while it was away. A kill for a run this daemon isn't
  holding is logged and ignored.
- A person's message reaches the daemon holding the run as `run.chat`, and the answer goes
  back as `node.chat.reply`, which the orchestrator stores and shows every tab. A message
  sent while the daemon is away is never sent: the orchestrator refuses it with `no_daemon`.
- The link reconnects on its own after a dropped connection or an orchestrator restart, and
  sends the events it buffered meanwhile. socket.io-client gives up on a refused handshake
  and on a socket the server closed, so the link tries again itself: a minute after a
  refusal, 5 seconds after a close.
- The orchestrator creates the `fix` queue with `retryLimit: 0`, a 20-minute expiry and
  the `fix_failed` dead letter queue, and the `run_finished` queue this daemon sends to. A
  result that can't be queued after 3 tries fails the fix job. So does a daemon that dies
  mid-run, once the job expires. Either way pg-boss copies the job to `fix_failed`, and the
  orchestrator fails the issue from it.
- `node.run.finished` for a submitted run carries its score as `confidence`. A
  `low_confidence` escalation needs an orchestrator that knows the reason (migration 007),
  so deploy the orchestrator before the daemons.
