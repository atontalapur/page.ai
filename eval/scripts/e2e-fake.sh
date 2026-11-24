#!/usr/bin/env bash
# Usage: pnpm e2e:fake [scenario-id] [pnpm e2e options]   (default 001-bad-currency-code)
# Plays one code scenario through the whole pipeline on fakes (#211): builds the orchestrator,
# starts it and a node daemon with USE_FAKE_ADAPTERS on DATABASE_URL, then runs
# `pnpm e2e <id> --target fake` against them. No PostHog, Docker, GitHub or model, so it costs
# nothing. CI's `pipeline` job runs it. Locally, point DATABASE_URL at a database you don't
# mind filling with test issues, not one an orchestrator you use reads.
set -euo pipefail

id="${1:-001-bad-currency-code}"
shift || true
: "${DATABASE_URL:?DATABASE_URL is required: the database the orchestrator and daemon share}"
port="${E2E_FAKE_PORT:-4100}"
url="http://127.0.0.1:$port"
logs="$(mktemp -d)"

# Throwaway secrets: both apps listen on 127.0.0.1 only and stop with this script.
webhook_secret="$(openssl rand -hex 16)"
api_token="$(openssl rand -hex 16)"
node_secret="$(openssl rand -hex 16)"

pids=()
cleanup() {
  for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null || true; done
}
trap cleanup EXIT

show_logs() {
  for app in orchestrator node; do
    echo "--- $app log (last 40 lines)"
    tail -n 40 "$logs/$app.log" || true
  done
}

pnpm --filter @page/orchestrator build

# env -i: nothing from this shell or a .env reaches the apps, so no Twilio, PostHog or
# OpenRouter key can turn a fake run into a real call.
(
  cd apps/orchestrator
  exec env -i PATH="$PATH" HOME="$HOME" DATABASE_URL="$DATABASE_URL" \
    USE_FAKE_ADAPTERS=true AUTO_START_FIX=true \
    POSTHOG_WEBHOOK_SECRET="$webhook_secret" ORCHESTRATOR_API_TOKEN="$api_token" \
    NODE_SHARED_SECRET="$node_secret" HOST=127.0.0.1 PORT="$port" \
    node --enable-source-maps dist/apps/orchestrator/src/main.js
) >"$logs/orchestrator.log" 2>&1 &
pids+=("$!")

# The orchestrator creates the fix queue and the steps table at boot, so it goes first.
for _ in $(seq 1 60); do
  curl -sf "$url/health" >/dev/null && break
  if ! kill -0 "${pids[0]}" 2>/dev/null; then
    echo "the orchestrator exited before /health answered"
    show_logs
    exit 1
  fi
  sleep 1
done
curl -sf "$url/health" >/dev/null || { echo "no /health from $url after 60s"; show_logs; exit 1; }

(
  cd apps/node
  exec env -i PATH="$PATH" HOME="$HOME" DATABASE_URL="$DATABASE_URL" \
    USE_FAKE_ADAPTERS=true ORCHESTRATOR_URL="$url" NODE_SHARED_SECRET="$node_secret" \
    NODE_NAME=e2e-fake \
    node src/main.ts
) >"$logs/node.log" 2>&1 &
pids+=("$!")

status=0
env -i PATH="$PATH" HOME="$HOME" E2E_DATABASE_URL="$DATABASE_URL" E2E_ORCHESTRATOR_URL="$url" \
  E2E_ORCHESTRATOR_API_TOKEN="$api_token" E2E_POSTHOG_WEBHOOK_SECRET="$webhook_secret" \
  node eval/scripts/e2e.ts "$id" --target fake "$@" || status=$?
[ "$status" -eq 0 ] || show_logs
exit "$status"
