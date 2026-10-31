# scenarios

Seeded bugs for the demo app. Each one lives in `scenarios/<id>/`, where the id is three
digits and a kebab-case slug (`001-bad-currency-code`).

| File                  | What it does                                                                        |
| --------------------- | ----------------------------------------------------------------------------------- |
| `break.sh`            | Plants the bug in a clean demo app. Fails if it couldn't (the code it edits moved). |
| `trigger.sh`          | Makes the bug fire on a running app at `$DEMO_APP_URL`, so PostHog sees it.         |
| `check.sh`            | Exits 0 when the bug is fixed and 1 while it's there.                               |
| `reference_fix.patch` | A known fix, applied on top of `break.sh` with `git apply`.                         |
| `meta.json`           | `class`, `expectedTier` and a one-line `description` (`ScenarioMeta` in contracts). |

`break.sh` and `check.sh` run in the sandbox image (Alpine, busybox `sh`, no bash) from
`/workspace`, the repo root, as the sandbox user. They get no network. `check.sh` must
exit 1 for the bug, so the self-test can tell it apart from a check that crashed or a
dead sandbox (125-127 from `docker exec`, 137 from the OOM killer). A failed `assert`
in `node` exits 1. Under `set -e` the script exits with the failing command's code, so
map other failures to 1 yourself.

`trigger.sh` runs outside the sandbox, from the eval runner's host, against a deployed
demo app (staging, for the PostHog demo). It needs the network and `curl`. The self-test
doesn't run it.

Keep all three executable.

## check.sh never goes in the sandbox

The agent works in the same container `check.sh` later runs in, so if it could read the
check it could fix the test instead of the bug. The sandbox image bakes in only the demo
app, and the runner pipes each script in over stdin (`docker exec -i ... sh -s`) instead
of copying it. The self-test checks before and after each run that no `check.sh` and no
`scenarios/` directory exist in the container.

Write checks that don't lean on the demo app's own tests, since the agent can edit those.

## Self-test

Every scenario must pass this before it counts:

1. On a clean demo app, `check.sh` passes.
2. After `break.sh`, it fails.
3. After `reference_fix.patch`, it passes again.

Run it from the repo root against a built sandbox image:

```sh
docker build -f infra/sandbox/Dockerfile -t page-sandbox .
pnpm scenarios:selftest page-sandbox                         # every scenario
pnpm scenarios:selftest page-sandbox 001-bad-currency-code   # just these
```

CI self-tests the scenarios a PR touches (`.github/workflows/scenarios.yml`).
