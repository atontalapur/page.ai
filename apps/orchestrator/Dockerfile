# Orchestrator image. Build from the repo root:
#   docker build -f apps/orchestrator/Dockerfile .
# Runtime commands use node directly, so pnpm is only needed at build time.
FROM node:24-alpine AS base
ENV HUSKY=0
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/db-migrations/package.json packages/db-migrations/
COPY apps/orchestrator/package.json apps/orchestrator/

FROM base AS build
COPY packages/config/package.json packages/config/
RUN pnpm install --frozen-lockfile --filter @page/orchestrator... --ignore-scripts
COPY packages/config packages/config
COPY packages/contracts packages/contracts
COPY packages/db-migrations packages/db-migrations
COPY apps/orchestrator apps/orchestrator
RUN pnpm --filter @page/orchestrator build

# Production dependencies only. Not pnpm deploy: it copies @page/* into node_modules, and
# Node won't strip types there. The dist imports @page/* as .ts sources, so keep the
# workspace layout, where they are symlinks to packages/.
FROM base AS prod
RUN pnpm install --prod --frozen-lockfile --ignore-scripts \
  --filter @page/orchestrator --filter @page/contracts --filter @page/db-migrations
COPY packages/contracts/src packages/contracts/src
# loadMigrations reads these .sql files at boot.
COPY packages/db-migrations/src packages/db-migrations/src
COPY packages/db-migrations/migrations packages/db-migrations/migrations
COPY --from=build /repo/apps/orchestrator/dist apps/orchestrator/dist

FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=prod --chown=node:node /repo /app
WORKDIR /app/apps/orchestrator
USER node
EXPOSE 4000
CMD ["node", "--enable-source-maps", "dist/apps/orchestrator/src/main.js"]
