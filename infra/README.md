# infra

Sandbox base image and deployment config. See #5 and #22.

## Sandbox image

`sandbox/Dockerfile` is the container every agent run executes commands in. It has the
demo app and its dependencies baked into `/workspace` as a git repo with one `baseline`
commit, and runs as a non-root user with no network. The limits and the reasons for them
are in [ADR 0001](../docs/adr/0001-sandbox-network-policy.md).

Build it and check it from the repo root:

```sh
docker build -f infra/sandbox/Dockerfile -t page-sandbox .
infra/sandbox/smoke.sh page-sandbox
```

Start one by hand and run commands in it:

```sh
name=$(node apps/node/scripts/sandbox-run.ts page-sandbox)
docker exec -w /workspace/apps/demo-app "$name" pnpm test
docker stop "$name"
```

CI builds the image and runs the smoke test on PRs that touch its inputs, and pushes
`ghcr.io/atontalapur/page.ai/sandbox:<sha>` and `:latest` from `main`.
