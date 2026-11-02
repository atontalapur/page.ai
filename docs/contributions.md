# Contributions

One line per finished card: date, card, who, what landed.

- 2026-10-29 · #1 · Advaith · Demo app: Next.js shop (products, cart, checkout, JSON API) on Postgres with SQL migrations, seed, PGlite unit tests, Dockerfile, compose service and Railway config.
- 2026-10-30 · #5 · Advaith · Sandbox image: offline Node 24 image with the demo app baked in, docker run helper (no network, 1 CPU, 1 GB, nothing writable outside the repo and /tmp, 15 min), smoke test, GHCR workflow and ADR 0001. PGlite tests fixed to fit in 1 GB.
- 2026-10-30 · #6 · Advaith · Scenario format: `ScenarioMeta` schema in contracts, `@page/eval` loader and self-test runner (clean passes, broken fails, fixed passes; check.sh piped over stdin and never in the sandbox), `pnpm scenarios:selftest`, a sample scenario (001-bad-currency-code) and a CI job that self-tests touched scenarios.
- 2026-10-30 · #7 · Advaith · Seeded bugs 002-010 (with 001 from #6: 3 frontend, 3 backend/API, 2 database, 2 infra/config). Each passes the self-test and returns a 500 from `trigger.sh` on a local app. The staging PostHog check waits on #2.
- 2026-11-02 · #3 · Advaith · `execute()` in `@page/toolkit`: a sh parser that refuses expansion, substitution, subshells and globs; a blocklist for every tier (sudo, curl, wget, docker, force pushes, writes outside the repo or under `.github/` and `.git/`); the Tier 1 allowlist with argument rules; `DockerExecRunner` with an in-container timeout that kills the whole command; a fake runner; head-and-tail output trimming; and the edit tool. `git apply` left out of Tier 1.
