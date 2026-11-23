# Node daemon image with its sandbox inside (SANDBOX_RUNTIME=local), for hosts without
# Docker such as Railway. Build from the repo root:
#   docker build -f apps/node/Dockerfile .
# /workspace holds page-demo at PAGE_DEMO_REF, which must be the tree the deployed demo app
# runs, so the agent's diff applies to it. Redeploy after page-demo main changes.
# Where Docker is available, run the daemon with SANDBOX_RUNTIME=docker instead: each run
# then gets its own container with no network (docs/adr/0001-sandbox-network-policy.md).
FROM node:24-alpine AS base
ENV HUSKY=0
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/agent/package.json packages/agent/
COPY packages/contracts/package.json packages/contracts/
COPY packages/model-client/package.json packages/model-client/
COPY packages/toolkit/package.json packages/toolkit/
COPY apps/node/package.json apps/node/

# Production dependencies only. Node runs the .ts sources directly and the @page/*
# packages are symlinks to packages/, as in the orchestrator image.
FROM base AS prod
RUN pnpm install --prod --frozen-lockfile --ignore-scripts \
  --filter @page/node --filter @page/agent --filter @page/contracts \
  --filter @page/model-client --filter @page/toolkit
COPY packages/agent/src packages/agent/src
COPY packages/contracts/src packages/contracts/src
COPY packages/model-client/src packages/model-client/src
COPY packages/toolkit/src packages/toolkit/src
COPY apps/node/src apps/node/src

# The demo app the agent works on, with its dev tools, since the agent runs tests, lint and
# typecheck. As in infra/sandbox/Dockerfile: route types first, then a fresh repo whose
# baseline commit is the start of the agent's diff.
FROM node:24-alpine AS workspace
ARG PAGE_DEMO_REPO=https://github.com/atontalapur/page-demo
ARG PAGE_DEMO_REF=main
ENV HUSKY=0 COREPACK_HOME=/opt/corepack COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN apk add --no-cache git && corepack enable
WORKDIR /workspace
RUN git clone -q "$PAGE_DEMO_REPO" . && git checkout -q "$PAGE_DEMO_REF" && rm -rf .git
RUN pnpm install --frozen-lockfile --filter @page/demo-app... --ignore-scripts \
      --store-dir /tmp/pnpm-store \
  && rm -rf /tmp/pnpm-store \
  && NEXT_TELEMETRY_DISABLED=1 pnpm --filter @page/demo-app exec next typegen
RUN git init -q -b main \
  && git add -A \
  && git -c user.name=sandbox -c user.email=sandbox@page.invalid commit -qm baseline

FROM node:24-alpine
# su-exec runs each command as the sandbox user; busybox gives timeout, pkill and find.
RUN apk add --no-cache git ripgrep su-exec tini \
  && adduser -D -H -h /tmp sandbox
ENV NODE_ENV=production \
    SANDBOX_RUNTIME=local \
    COREPACK_HOME=/opt/corepack \
    COREPACK_ENABLE_NETWORK=0
# pnpm, fetched once at build. Commands can't fetch it: they run with COREPACK_ENABLE_NETWORK=0.
COPY --from=workspace /opt/corepack /opt/corepack
RUN corepack enable
COPY --from=workspace --chown=sandbox:sandbox /workspace /workspace
COPY --from=prod /repo /app
WORKDIR /app/apps/node
# Root: it switches to the sandbox user for each command, and keeps its keys from it.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/main.ts"]
