# Whole stack in one image: the orchestrator (port 4000) and the demo app (port 3000).
# Postgres stays outside; pass its URL as DATABASE_URL. Build the two app images first,
# from the repo root, then this one:
#   docker build -f apps/orchestrator/Dockerfile -t page-orchestrator .
#   docker build -f apps/demo-app/Dockerfile -t page-demo-app .
#   docker build -f infra/stack/Dockerfile -t page-stack .
# Copying from the app images keeps one build recipe per app.
ARG ORCHESTRATOR_IMAGE=page-orchestrator
ARG DEMO_APP_IMAGE=page-demo-app
FROM ${ORCHESTRATOR_IMAGE} AS orchestrator
FROM ${DEMO_APP_IMAGE} AS demo-app

FROM node:24-alpine
ENV NODE_ENV=production
RUN apk add --no-cache tini
COPY --from=orchestrator --chown=node:node /app /app/orchestrator
COPY --from=demo-app --chown=node:node /app /app/demo
COPY --chmod=755 infra/stack/start.sh /usr/local/bin/start-stack
USER node
EXPOSE 3000 4000
LABEL org.opencontainers.image.source=https://github.com/atontalapur/page.ai \
      org.opencontainers.image.description="PageAgents orchestrator and demo app"
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["start-stack"]
