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
| `SANDBOX_IMAGE`               | `page-sandbox` | Built from `infra/sandbox/Dockerfile`   |
| `SANDBOX_RUNTIME`             | `docker`       | `local` on hosts without Docker (below) |
| `OPENROUTER_API_KEY`          |                | Required unless `USE_FAKE_ADAPTERS`     |
| `OPENROUTER_MODEL`            |                | Required unless `USE_FAKE_ADAPTERS`     |
| `GITHUB_TOKEN`, `GITHUB_REPO` |                | Required unless fakes; Tier 2 tools     |
| `OPS_APP_URL`                 |                | Optional; the app for Tier 3 ops tools  |
| `OPS_SECRET`                  |                | That app's ops secret; needs 32+ chars  |
| `USE_FAKE_ADAPTERS`           | `false`        | See below                               |
| `LOG_LEVEL`                   | `info`         |                                         |

With `USE_FAKE_ADAPTERS=true` there is no Docker, model, GitHub or socket. Each run gets a
fake sandbox whose commands exit 0, a scripted model that runs `git status` and submits, an
in-memory GitHub, an in-memory ops API, and a link that logs events instead of sending them. Postgres stays real, so steps still land in
the `steps` table.

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
app. It needs no port.

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
tools. A job expiry, or a kill once the orchestrator relays one, aborts the agent's request
in flight and stops any further one.

A Tier 3 run claims the app before it starts, and holds it until it finishes, so two runs
can't change and restart the app under each other. The claim is a Postgres advisory lock
keyed on `OPS_APP_URL`, which every daemon on the same database sees, plus the lock
directory `pnpm eval:run` takes on this machine. While someone else holds the app, each ops
call is refused with `the live app is in use by another run or eval`, and the agent can
escalate. A daemon killed outright leaves that directory behind, which then refuses every
Tier 3 run on the machine; the warning logs its path (`lockDir`), so remove it once nothing
is using the app. An eval on another machine doesn't see the claim, so don't run one
against an app a daemon is using.

A Tier 3 run that ends any way but submitted (it fails, escalates, expires or is killed)
puts back each override it changed, and restarts the app if it restarted it after a change,
so the tier above starts from the app this run found. These requests go out after the run
has stopped, kill included, and before its result is queued. It is best effort, like
closing the PR of a run that didn't succeed: it tries every setting and the restart, and
logs each one the app wouldn't take. A change whose request never answered, say because a
kill cut it off, may have landed, and is logged by name and left as it is.

Without `OPS_APP_URL` the daemon logs once at startup that Tier 3 runs get no ops tools, and
every ops call is refused as `not set up on this node`. The daemon never reads
`DEMO_APP_URL`, which `.env` keeps for staging's app, so a local daemon changes staging only
if `OPS_APP_URL` names it.

## Tests

```sh
pnpm --filter @page/node test               # unit, with fakes
pnpm --filter @page/node test:integration   # needs DATABASE_URL and Docker
```

The integration tests claim a job from a real pg-boss queue, run it end to end with fake
Docker and model and check the `steps` row, and start and remove a real container.

## Open points for the orchestrator side

- Socket.IO server: serve the `/node` namespace, check `auth.token` against
  `NODE_SHARED_SECRET`, and accept the `nodeToServerEvents` from contracts.
- The daemon writes steps itself, because `execute()` must not run a command whose step
  it couldn't record. The server should relay `node.step` to the UI, not insert it again.
- The orchestrator creates the `fix` queue with `retryLimit: 0`, a 20-minute expiry and
  the `fix_failed` dead letter queue, and the `run_finished` queue this daemon sends to. A
  result that can't be queued after 3 tries fails the fix job. So does a daemon that dies
  mid-run, once the job expires. Either way pg-boss copies the job to `fix_failed`, and the
  orchestrator fails the issue from it.
- `node.run.finished` for a submitted run is `succeeded` with `confidence: null`, since
  nothing scores runs yet.
