# ui

Vite and React dashboard. The orchestrator serves the build (`apps/ui/dist`) on its own port,
next to the API and the socket, so in production the UI talks to the origin that served it.

## Issues and agents, live

`IssuesProvider` (`src/context/IssuesContext.tsx`) holds what every page reads: the issues
(`useIssues`) and the node daemons (`useAgents`). A source keeps it current:

- **Server** (`src/live/server-source.ts`), when the page's own `/health` answers JSON, which
  means an orchestrator served it. It connects to the `/ui` Socket.IO namespace, then loads
  `GET /issues` and `GET /nodes`, and applies `issue.updated`, `node.updated` and the run
  events (`run.started`, `run.step`, `run.diff`, `run.finished`, and the messages people send
  a run, `run.chat.asked` and `run.chat.reply`) as they arrive. Each reconnect
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

### Asking the agent

The newest run on the incident page has a box to send the agent a message while it works
(`AskAgent` in `src/components/issues/RunChat.tsx`): a question about what it is doing, or a
pointer. The agent reads it before its next step and answers in that step, without stopping.
It is guidance only: the run's tier, policy and approvals still decide what it may do.

- **Sending.** `askAgent` on the source emits `run.chat` and waits for the server:
  `run.chat.asked` with the same run and text means it is stored and on its way to the daemon,
  and `run.chat.refused` says why it isn't (no name, over the chat limit, the run is no longer
  in progress, no daemon holds it, or the run has had 10 messages). The page gives up after 10
  seconds, or at once when the socket drops, and says so. A message that didn't go out stays in
  the box with the reason under it. Cmd or Ctrl with Enter sends.
- **Shut.** The box is disabled, with the reason, while the run has ended, no connected daemon
  holds it (from the live agents list), or the tab is not connected. An ended run keeps the box
  only if someone talked to it, and each run's box starts empty.
- **Who sends it.** A message is recorded under the identity a Tier 3 decision gets: a
  personal token sends as the person it names ("As Arjun", nothing to change); the shared
  token, once the orchestrator has personal tokens, can't send, and the box is shut with
  "Connect with your personal token"; with no personal tokens configured, the box asks for the
  tab's name first, as the approval bar does.
- **The conversation.** Each message shows in the run's steps after the step that started
  before it was asked, with its answer once the agent gives it, or why it has none: not read
  because too many were waiting or the agent had already submitted, not answered because the
  run ended first, read and not answered, or not delivered. Messages arrive as run events, so
  every open tab shows them live, and a reconnect loads them again with the runs. A pending
  copy never replaces an answer.

The mock source sends no messages: the box says the page isn't connected to an orchestrator.

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

## Token and sign-in

The orchestrator API and socket need a token: a person's dashboard token, or the shared
`ORCHESTRATOR_API_TOKEN` (`apps/orchestrator/README.md`, Tokens). The UI asks for one the
first time a tab connects, keeps it in `sessionStorage` (this tab only, gone when it closes),
and sends it as `Authorization: Bearer <token>` on HTTP and as `auth.token` in the socket
handshake. If the orchestrator refuses it, the UI forgets it and asks again. The static files
themselves need no token.

Once connected, the UI asks `GET /me` who the token names (`session` in `IssuesProvider`):

- **A personal token** shows "Signed in as <name>" in the header, and the Tier 3 approval bar
  decides under that name with no name to type.
- **The shared token, once the orchestrator has personal tokens**, can't approve or reject.
  The bar says so and offers to connect with a personal token, which forgets the shared one
  and shows the prompt again.
- **The shared token with no personal tokens configured**, an orchestrator from before
  `/me`, or the mock source: the bar asks for a name, keeps it in `localStorage`, and sends it
  as `auth.name`, as before.

## Run

```sh
pnpm --filter @page/ui dev                                         # mock source, :5173
ORCHESTRATOR_URL=http://localhost:4000 pnpm --filter @page/ui dev  # a local orchestrator
pnpm --filter @page/ui build                                       # dist/, which :4000 serves
```

With `ORCHESTRATOR_URL` set, the dev server proxies `/health`, `/issues`, `/nodes`,
`/approvals`, `/me` and `/socket.io` to it.
The orchestrator finds the build's files when it starts, so restart it after a rebuild.
