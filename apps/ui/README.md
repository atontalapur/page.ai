# ui

Vite and React dashboard. The orchestrator serves the build (`apps/ui/dist`) on its own port,
next to the API and the socket, so in production the UI talks to the origin that served it.

## Issues and agents, live

`IssuesProvider` (`src/context/IssuesContext.tsx`) holds what every page reads: the issues
(`useIssues`) and the node daemons (`useAgents`). A source keeps it current:

- **Server** (`src/live/server-source.ts`), when the page's own `/health` answers JSON, which
  means an orchestrator served it. It connects to the `/ui` Socket.IO namespace, then loads
  `GET /issues` and `GET /nodes`, and applies `issue.updated`, `node.updated` and the run
  events (`run.started`, `run.step`, `run.diff`, `run.finished`) as they arrive. Each reconnect
  loads both lists again for the changes it missed. A detail page whose issue isn't in the list
  (the list holds the 200 most recent) fetches `GET /issues/:id` once.
- **Mock** (`src/live/mock-source.ts`), when nothing answers `/health` with JSON, as under
  `vite` on its own. It plays an issue's life every 4s: an error arrives, is triaged, repeats,
  starts a fix, escalates, waits for approval and is approved. Three mock daemons
  (`src/live/mock-nodes.ts`) take each fix, write a step every tick, and finish the run when its
  issue escalates or goes for approval; one drops off and comes back now and then. The "Start a
  fix" button works on it too.

Both sources parse every event with its schema in `serverToUiEvents` from `@page/contracts`
and drop one that breaks it, so the mock is held to the server's contract. The store keeps the
newer copy of an issue (by `updatedAt`), so an event that arrives during the list load isn't
lost, and a `node.updated` that lands while `GET /nodes` loads is applied again after it. The
header badge shows which source is running and whether it is connected.

### Runs and their steps

`useIssueRuns` and `useNodeRuns` (`src/live/useLiveRuns.ts`) load a list of runs
(`GET /issues/:id/runs`, `GET /nodes/:name/runs`) and apply each run event to it as it
arrives, so steps appear as the daemon sends them. A tab that was disconnected misses the
events sent meanwhile, so the source tells the store each time the socket connects, and both
hooks load their runs again then. Events that land while a load is in flight are applied again
on top of what it returns. The incident page loads an issue's runs again when the issue
changes; the agent page loads a daemon's runs again when it takes a new one.

## Agents

An agent is a node daemon (`apps/node`), named by its `NODE_NAME` or its hostname. It runs fix
jobs at Tier 1 to 3; there are no agent types, and no way to hand one a task of your choosing.

- **`/agents`** lists every daemon the orchestrator knows: connected, seen leaving, or known
  from the runs it worked. Each card shows whether it is running a fix, idle or offline, the
  run it holds (incident, tier, status, step count and last step), or when it last took one.
- **`/agents/:name`** shows the daemon's connection, the run it holds with every step as it
  arrives, and its 20 most recent runs.
- **Dashboard**: the Running Agents figure and the Agents card read the same daemons, and
  Fixes in Progress counts issues that are fixing.
- **Start a fix** sends `start_fix` for a triaged incident (`POST /issues/:id/events`). The
  orchestrator queues a Tier 1 fix job and the first free daemon claims it.

## API token

The orchestrator API and socket need `ORCHESTRATOR_API_TOKEN`. The UI asks for it the first
time a tab connects, keeps it in `sessionStorage` (this tab only, gone when it closes), and
sends it as `Authorization: Bearer <token>` on HTTP and as `auth.token` in the socket
handshake. If the orchestrator refuses it, the UI forgets it and asks again. The static files
themselves need no token.

## Run

```sh
pnpm --filter @page/ui dev                                         # mock source, :5173
ORCHESTRATOR_URL=http://localhost:4000 pnpm --filter @page/ui dev  # a local orchestrator
pnpm --filter @page/ui build                                       # dist/, which :4000 serves
```

With `ORCHESTRATOR_URL` set, the dev server proxies `/health`, `/issues`, `/nodes` and
`/socket.io` to it.
The orchestrator finds the build's files when it starts, so restart it after a rebuild.
