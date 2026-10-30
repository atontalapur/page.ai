# Demo app image. Build from the repo root:
#   docker build -f apps/demo-app/Dockerfile .
# Runtime commands use node directly, so pnpm is only needed at build time.
FROM node:24-alpine AS build
ENV HUSKY=0
RUN corepack enable
WORKDIR /repo

# Manifests first so the dependency layer is cached until the lockfile changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/config/package.json packages/config/
COPY apps/demo-app/package.json apps/demo-app/
RUN pnpm install --frozen-lockfile --filter @page/demo-app... --ignore-scripts

COPY packages/config packages/config
COPY apps/demo-app apps/demo-app
RUN pnpm --filter @page/demo-app build

# Production dependencies only (no vitest, eslint, typescript or pglite). The app has no
# runtime workspace dependencies, so the legacy deploy needs no injected packages.
# Deploy copies .next without its node_modules, so copy the build over it. Turbopack links
# server externals (pg) from .next/node_modules into the monorepo's pnpm store, which
# isn't in /out, so point each link at the deployed node_modules instead.
RUN pnpm --filter @page/demo-app deploy --prod --legacy --ignore-scripts /out \
  && rm -rf /out/.next && cp -r apps/demo-app/.next /out/.next \
  && rm -rf /out/.next/cache \
  && for link in /out/.next/node_modules/*; do \
       [ -L "$link" ] || continue; \
       ln -sfn "../../node_modules/$(readlink "$link" | sed 's|.*/node_modules/||')" "$link"; \
     done

FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out /app
USER node
EXPOSE 3000
CMD ["node_modules/.bin/next", "start"]
