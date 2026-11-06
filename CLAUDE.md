# page.ai (PageAgents)

Agents that fix production bugs. PostHog reports an exception from the demo app, the
orchestrator opens an issue, and an agent works in a locked-down sandbox at Tier 1, 2 or
3 until it opens a PR or escalates. README.md has the proposal; `docs/adr/` has decisions.

## Commands

Run from the repo root.

```sh
pnpm install --frozen-lockfile
pnpm lint            # turbo lint, then depcruise
pnpm typecheck
pnpm test            # unit tests with coverage gates
pnpm test:integration  # needs DATABASE_URL (pnpm db:up) and Docker for toolkit
pnpm format:check    # pnpm format to fix
pnpm db:up / pnpm db:down   # local Postgres 18 from docker-compose.yml
pnpm scenarios:selftest page-sandbox [id...]   # after building the sandbox image
docker build -f infra/sandbox/Dockerfile -t page-sandbox .
```

- One package: `pnpm --filter @page/<name> <script>`.
- Skip the turbo cache with `pnpm turbo run lint --force`. `pnpm lint --force` passes
  `--force` to depcruise, which rejects it.
- Before opening a PR, run root `lint`, `typecheck`, `test` and `format:check`. Run
  `test:integration` when the change touches Postgres or Docker code.

## Layout

- `apps/orchestrator`: NestJS on Fastify, Kysely, pg-boss. Issue state machine, fix-job
  queue, HTTP API. Builds with `tsc` to `dist/` because Nest needs decorator metadata.
- `apps/node`: daemon that runs the agent and starts sandboxes (`src/sandbox/run-args.ts`).
- `apps/ui`: Vite 8 + React 19 + Tailwind 4.
- `apps/demo-app`: Next.js 16 + Postgres shop that agents treat as production and that
  the seeded bugs break. Plain SQL migrations, PGlite unit tests, Railway deploy.
- `packages/contracts`: zod schemas shared by everything (db rows, jobs, events,
  webhook, config, `ScenarioMeta`). Fixtures at `@page/contracts/fixtures`.
- `packages/toolkit`: `execute()`, the only way the agent runs anything. Shell parser,
  tier policy, Docker runner, edit tool, audit log, deploy/rollback.
- `packages/agent`: TypeScript port of mini-swe-agent's text loop, with transcript replay.
- `packages/model-client`: `ModelClient` and `OpenRouterClient`.
- `packages/design-system`: shadcn catalog themed with Radix Colors.
- `packages/config`: shared tsconfig, ESLint, Prettier and Vitest presets.
- `eval/` (`@page/eval`): scenario loader, self-test runner, transcript recorder.
- `scenarios/<NNN-slug>/`: seeded bugs. Format is in `scenarios/README.md`.
- `infra/sandbox/`: the agent sandbox image and `smoke.sh`.

## Tooling

- Node 24 (`.nvmrc`), pnpm 12.16.1 (`packageManager`). LF line endings only.
- Every shared dependency version lives in the `pnpm-workspace.yaml` catalog. Reference
  it with `"catalog:"`. Bump `vitest` with `@vitest/coverage-v8`, and `vite` with `vitest`.
- pnpm blocks dependency build scripts. Avoid deps that need them (this is why there is
  no `tsx`/esbuild). If one is unavoidable, add it to `allowBuilds` with a reason.
- Node runs `.ts` files directly by stripping types. Imports use `.ts` extensions
  (`allowImportingTsExtensions`). Packages that Node runs as source use
  `erasableSyntaxOnly` via `@page/config/tsconfig/node-ts.json`, so no enums, namespaces
  or parameter properties there.
- Workspace packages export `src/index.ts` directly. No build step for packages.
- tsconfig presets: `base.json` for Node, `react.json` for ui and demo-app. Both are
  `strict` with `noUncheckedIndexedAccess`. ESLint bans `any`.
- demo-app `lint` and `typecheck` both run `next typegen` first.

## Import rules (dependency-cruiser, enforced in CI)

- Packages never import apps.
- Apps never import another app. They share types through `@page/contracts`.
- `contracts` imports only `zod`.
- `agent` reaches the outside world only through `toolkit` and `model-client`.
- Type-only imports count.

## Code conventions

- Expected failures are `Result` values (`ok`/`err`), not exceptions. Exceptions mean
  something is actually broken (runner crash, bug).
- External services sit behind a port with a fake: `ErrorReporter`/`FakeErrorReporter`,
  `AuditSink`/`InMemoryAuditSink`, `Deployer`/`FakeDeployer`, `FakeRunner`,
  `ModelClient`. Unit tests use the fakes. `USE_FAKE_ADAPTERS=true` makes third-party
  secrets optional.
- Contracts: ids are `z.uuid()`, timestamps are ISO strings normalized to UTC `Z`, fields
  are camelCase (the DB layer maps column names). Every job and event payload carries
  `v: z.literal(1)`. Every schema gets a fixture, a round-trip test and at least one
  rejected case. The fixture maps are typed so a new queue or event without a fixture
  fails typecheck.
- Env config: a shared base schema in contracts, extended per app. Blank vars count as
  unset. Report every missing var in one error.
- Bug classes are hyphenated: `frontend`, `backend-api`, `database`, `infra-config`.
- Logging is pino. Agent-run log lines carry `issueId`, `runId` and `tier`.
- Migrations are plain SQL in `migrations/NNN_name.sql`, applied under an advisory lock.
  demo-app scenario checks that list allowed migrations must be updated when one is added.

## Tests and coverage

- `*.test.ts` is unit, `*.int.test.ts` is integration. Coverage counts unit only.
- Gates: 70% per package, 90% for all of `packages/toolkit`, and 90% per file for any
  path where a word starts with `tier` or `approval`.
- `passWithNoTests` is `false` everywhere. Scripts with no tests behind them pass
  `--passWithNoTests` themselves, and drop it with their first test.
- The demo app also fails a run where every test was skipped. Keep reporters as
  `[...configDefaults.reporters, ...]` so CI keeps the `github-actions` reporter.
- Database tests use PGlite. Close every instance. demo-app loads migrated snapshots
  from `globalSetup` instead of running initdb per test.
- Integration tests run in throwaway Postgres schemas.
- Slow cold-start tests get an explicit timeout (demo-app `testTimeout: 15_000`, Docker
  tests `20_000`). Don't lower them to the 5s default.

## Sandbox and agent safety

These are deliberate. Don't loosen them without an ADR or an explicit decision.

- Sandbox: `--network none`, 1 CPU, 1 GB no swap, 256 pids, `--cap-drop ALL`,
  `no-new-privileges`, 128 MB `/tmp`, writable only in `/workspace` and `/tmp`, 15 min
  wall clock. The image sets `PAGE_SANDBOX=1`, which makes Vitest use `--liftoff-only`.
- API keys stay in the daemon. Nothing secret enters the container.
- `check.sh` and `scenarios/` never enter the sandbox. Scripts are piped over stdin.
- `execute()` refuses anything the parser can't reason about (`$`, backticks,
  subshells, heredocs, globs, `&`, `~`). Blocked at every tier: `sudo su doas curl wget
docker`, force pushes, writes outside `/workspace` or under `.github/`, `.git/`,
  `node_modules/`, or through `..`. `git apply` is not in Tier 1; file changes go through
  the edit tool.
- The policy also refuses vitest flags that would hide a non-run (`--passWithNoTests`,
  `vitest related`, `--reporter`). Add to that list if a new flag can fake a pass.
- Every `execute()` call writes one `steps` row, refusals included. If the audit write
  fails, the command does not run.
- Agent output has colour off and ANSI codes stripped before the 8000-char trim.
- The toolkit policy is not the security boundary. The sandbox is.
- Ops routes in the demo app skip `shop()` so a bad setting can't lock out the fix.
  Anything destructive takes `?dryRun=true`, and unknown query params are a 400.

## Scenarios

- Every scenario has `break.sh`, `trigger.sh`, `check.sh`, `reference_fix.patch` and
  `meta.json` (with a required `report`). Scripts stay executable.
- A Tier 3 (`expectedTier: 3`) scenario is an ops scenario instead: `break-ops.sh`,
  `fix-ops.sh`, `trigger.sh`, `check.sh` and `meta.json`, all run on the host against the
  live app at `$DEMO_APP_URL`. Its bug is app state and its fix an ops action, not a patch.
- `break.sh` and `check.sh` run in busybox `sh` (no bash). `check.sh` exits 1 for the
  bug, not just non-zero. `trigger.sh` runs on the host, which may be dash; use
  `printf '%s\n'`, not `echo`.
- Checks must not rely on the demo app's own tests, since the agent can edit them.
- Reports come from the error the broken app actually throws, captured from a real run,
  with paths relative to the repo root. They give request, status, error and stack, and
  never the cause or fix. Strip hints that point at the fix.
- The self-test checks report stack frames against the broken code. Changing demo-app
  lines that a report cites means updating that report.
- Every scenario must pass the self-test: check passes clean, fails after `break.sh`,
  passes after the patch (for ops: after `break-ops.sh`, then after `fix-ops.sh`).

## Git and PRs

- Never push to `main`. Branch names: `feat/...`, `fix/...`, `docs/...`, `chore/...`, or
  `<area>/<topic>` (`demo-app/ops-surface`).
- Conventional Commits with a scope where one fits: `feat(toolkit): ...`,
  `fix(demo-app): ...`. Subjects are lowercase. commitlint runs on commits (husky) and on
  the PR title, which becomes the squash commit.
- No Claude or Claude Code attribution anywhere: no `Co-Authored-By`, no "Generated
  with Claude Code", no session links, in commits, PR titles or PR bodies.
- Required CI checks are `checks`, `integration` and `pr-title`. Renaming those jobs
  breaks the branch ruleset. `selftest` and the sandbox image workflow are not required.
- PR body shape: `Closes #N` (or `Part of #N`), a short summary, a "What's in it" list,
  changes from the card and why, "Verified" with what was actually run and the result,
  and "Not done yet" / "Limits" for anything untested. Say plainly what wasn't run.
- Stacked PRs list the merge order at the top of each body.
- When a card is finished, add a line to `docs/contributions.md`: date, card, who, what.

## Reviews

When the user types `/full-review`, run `/code-review high` on the current branch, then
`/security-review`, and report both sets of findings. Don't fix anything until the user
picks which findings to act on.
