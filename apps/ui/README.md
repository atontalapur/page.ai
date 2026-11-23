# ui

Vite and React dashboard. The orchestrator serves the build (`apps/ui/dist`) on its own port,
next to the API and the socket, so in production the UI talks to the origin that served it.

## Issues, live

`IssuesProvider` (`src/context/IssuesContext.tsx`) holds the issues the incident pages and the
dashboard read. A source keeps it current:

- **Server** (`src/live/server-source.ts`), when the page's own `/health` answers JSON, which
  means an orchestrator served it. It connects to the `/ui` Socket.IO namespace, then loads
  `GET /issues`, and applies each `issue.updated` as it arrives. Each reconnect loads the list
  again for the changes it missed. A detail page whose issue isn't in the list (the list holds
  the 200 most recent) fetches `GET /issues/:id` once.
- **Mock** (`src/live/mock-source.ts`), when nothing answers `/health` with JSON, as under
  `vite` on its own. It plays an issue's life every 4s: an error arrives, is triaged, repeats,
  starts a fix, escalates, waits for approval and is approved.

Both sources parse every event with `serverToUiEvents['issue.updated']` from `@page/contracts`
and drop one that breaks it, so the mock is held to the server's contract. The store keeps the
newer copy of an issue (by `updatedAt`), so an event that arrives during the list load isn't
lost. The header badge shows which source is running and whether it is connected.

The agent and task pages still run on their own mock data (`src/data`).

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

With `ORCHESTRATOR_URL` set, the dev server proxies `/health`, `/issues` and `/socket.io` to it.
The orchestrator finds the build's files when it starts, so restart it after a rebuild.
