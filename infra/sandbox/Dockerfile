# Sandbox base image: the container every agent run executes commands in (#5).
# Build from the repo root:
#   docker build -f infra/sandbox/Dockerfile -t page-sandbox .
# The demo app and its full dependency tree (dev tools included, since the agent runs
# tests, lint and typecheck) are baked into /workspace, so a run needs no network.
FROM node:24-alpine
ENV HUSKY=0 \
    COREPACK_HOME=/opt/corepack \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN apk add --no-cache git ripgrep tini \
  && corepack enable \
  && mkdir -p /opt/corepack /workspace \
  && chown node:node /opt/corepack /workspace

USER node
WORKDIR /workspace

# Manifests first so the dependency layer is cached until the lockfile changes.
COPY --chown=node:node package.json pnpm-lock.yaml pnpm-workspace.yaml .gitignore .nvmrc ./
COPY --chown=node:node packages/config/package.json packages/config/
COPY --chown=node:node apps/demo-app/package.json apps/demo-app/
# The store is deleted in the same layer: node_modules keeps its hard links, so the
# image carries one copy of each package. pnpm itself is cached in COREPACK_HOME.
RUN pnpm install --frozen-lockfile --filter @page/demo-app... --ignore-scripts \
      --store-dir /tmp/pnpm-store \
  && rm -rf /tmp/pnpm-store

COPY --chown=node:node packages/config packages/config
COPY --chown=node:node apps/demo-app apps/demo-app

# .git is excluded from the build context, so start a fresh repo with the baked-in
# source as the baseline. The agent's diff is everything after this commit.
RUN git init -q -b main \
  && git add -A \
  && git -c user.name=sandbox -c user.email=sandbox@page.invalid commit -qm baseline

# The root filesystem stays writable so /workspace needs no volume copy at start, so the
# node user must own nothing outside /workspace. smoke.sh checks this.
USER root
RUN rm -rf /home/node/.cache /tmp/* \
  && chown -R root:root /opt/corepack /home/node \
  && chmod 755 /var/tmp
USER node

# Corepack must not try to fetch anything at run time; the network is off.
# PAGE_SANDBOX turns on the demo app's low-memory test settings (vitest.config.js).
ENV COREPACK_ENABLE_NETWORK=0 \
    HOME=/tmp \
    PAGE_SANDBOX=1
LABEL org.opencontainers.image.source=https://github.com/atontalapur/page.ai \
      org.opencontainers.image.description="PageAgents agent sandbox"

# The container stops itself after 15 minutes, so the wall clock holds even if the
# daemon that started it dies. Commands run alongside via `docker exec`.
# SANDBOX_LIMITS.wallClockSeconds in apps/node/src/sandbox/run-args.ts is the source of
# truth and overrides this; the CMD only covers a plain `docker run` of the image.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["sleep", "900"]
