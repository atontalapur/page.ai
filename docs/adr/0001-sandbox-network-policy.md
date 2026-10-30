# 0001. Sandbox network policy

- Status: Proposed (confirm at Monday planning; #18 lists where the agent loop runs as open)
- Date: 2026-10-30
- Card: #5

## Context

Every agent run executes shell commands chosen by a model against the demo app's code.
Those commands can be wrong or hostile: a seeded bug's fix attempt might `curl` a script,
read environment variables or loop forever. The node daemon (#8) needs a container it can
run commands in without trusting them.

The agent loop itself needs network access to call the model API, so it holds API keys.

## Decision

1. **No network in the container.** Sandboxes start with `--network none`. The image
   ships the demo app with its full dependency tree, pnpm and git, so tests, lint and
   typecheck run offline.
2. **The agent loop runs in the daemon, not the container.** The daemon calls the model,
   then runs each command with `docker exec`. API keys and tokens stay in the daemon's
   environment and never enter the container.
3. **Fixed limits per run:** 1 CPU, 1 GB of memory with no swap, 256 processes, no Linux
   capabilities and `no-new-privileges`. The sandbox user can write only to `/workspace`
   (the repo) and `/tmp` (a 128 MB tmpfs). The image enforces this with file ownership,
   not a read-only root: a writable volume for the repo would copy about 540 MB of
   `node_modules` on every start (3.5 to 6 s, against 0.35 s without). `smoke.sh` fails
   if anything else is writable by that user.
4. **15-minute wall clock owned by the container.** Its main process is `sleep 900`, so it
   stops on time even if the daemon crashes. Containers carry the `page.sandbox` label so
   cleanup (#9) can find strays.

The flags live in one place, `apps/node/src/sandbox/run-args.ts`.

## Consequences

- Anything that needs the network happens outside the sandbox: installing new packages,
  pushing branches and opening PRs. Pushing and PRs are the Tier 2 host tools in #10.
  A fix that adds a dependency can't be tested in the sandbox until the image is rebuilt.
- PGlite needs V8's baseline wasm compiler (`--liftoff-only`) to start inside 1 GB. The
  image sets `PAGE_SANDBOX=1`, and the demo app's Vitest config turns the flag on when it
  sees it. The unit suite takes about 40 s on one CPU.
- The image bakes in the demo app, so it's rebuilt and republished whenever
  `apps/demo-app` changes (`.github/workflows/sandbox-image.yml`).
- If the team instead runs the agent loop inside the container, decision 2 is reversed.
  The container would then need network access to the model API and the keys inside it,
  and decision 1 would need an egress allowlist in place of `--network none`.
