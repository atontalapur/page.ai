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

FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /repo
COPY --from=build /repo /repo
RUN chown -R node:node /repo/apps/demo-app/.next
USER node
WORKDIR /repo/apps/demo-app
EXPOSE 3000
CMD ["node_modules/.bin/next", "start"]
