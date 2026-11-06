# @page/node

The daemon that runs fix jobs (#8). It claims a job from the orchestrator's `fix` queue,
starts one sandbox container for the run, runs the agent loop on the host, and sends each
command into the container through toolkit's `execute()`. Every step is written to the
`steps` table, then streamed to the orchestrator as `node.step`. When the run ends it sends
`node.diff` (after a submit) and `node.run.finished`, and removes the container.

```
pg-boss `fix` queue -> PgBossJobSource -> runFixJob -> DockerSandboxes (one container per run)
                                              |-> runAgent -> execute() -> docker exec
                                              |-> PostgresAuditSink -> steps table
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
| `OPENROUTER_API_KEY`          |                | Required unless `USE_FAKE_ADAPTERS`     |
| `OPENROUTER_MODEL`            |                | Required unless `USE_FAKE_ADAPTERS`     |
| `GITHUB_TOKEN`, `GITHUB_REPO` |                | Required unless fakes; used by #10      |
| `USE_FAKE_ADAPTERS`           | `false`        | See below                               |
| `LOG_LEVEL`                   | `info`         |                                         |

With `USE_FAKE_ADAPTERS=true` there is no Docker, model or socket. Each run gets a fake
sandbox whose commands exit 0, a scripted model that runs `git status` and submits, and a
link that logs events instead of sending them. Postgres stays real, so steps still land in
the `steps` table.

Two things have to exist before a job will run:

- The `fix` queue. The orchestrator creates it at boot; until it has, the daemon logs
  `Queue fix does not exist` and keeps polling.
- The `steps` table. Until #25 adds it to the orchestrator migrations, create it from
  `packages/toolkit/src/audit/__fixtures__/steps.sql`.

Fix jobs need a `report` (the triaged error report). A job without one fails at once with
a note saying so, and no container starts.

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
- pg-boss expires an active job after 900 s by default, the same as the sandbox wall
  clock, and then retries it twice. The `fix` queue should set `expireInSeconds` above the
  run's 15 minutes. Decide whether a retry of a run makes sense at all (`retryLimit: 0`).
- `node.run.finished` for a submitted run is `succeeded` with `confidence: null`, since
  nothing scores runs yet.
