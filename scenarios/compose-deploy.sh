# Sourced by the ops scenarios whose bug is a bad deploy (024), which run on the host
# against the compose demo app (see README.md). Not a scenario: plain files in scenarios/
# are skipped.
#
# The compose stand-in for Railway deploys and rollbacks: a deploy recreates the demo-app
# service from another image, and a rollback recreates it from the image it ran before.
# Images stand in for deployments, and a history file for Railway's deployment list. Runs
# from the repo root, with the same COMPOSE_PROJECT_NAME, ports and OPS_SECRET the app was
# started with.

deploy_history() {
  printf '%s\n' "${PAGE_DEPLOY_HISTORY:-${TMPDIR:-/tmp}/page-demo-app-deploys}"
}

# The image the demo-app service runs now.
live_image() {
  docker inspect --format '{{.Config.Image}}' "$(docker compose ps -q demo-app)"
}

serve_image() {
  DEMO_APP_IMAGE="$1" docker compose up -d --no-deps --wait demo-app
}

# build_image <tag> <patch>: builds the demo app image from HEAD with a patch on top.
build_image() {
  src="$(mktemp -d)"
  git archive HEAD package.json pnpm-lock.yaml pnpm-workspace.yaml .dockerignore \
    packages/config apps/demo-app | tar -x -C "$src"
  (cd "$src" && git apply "$2") || { rm -rf "$src"; return 1; }
  docker build -q --load -f "$src/apps/demo-app/Dockerfile" -t "$1" "$src" >/dev/null ||
    { rm -rf "$src"; return 1; }
  rm -rf "$src"
}

# deploy <image>: serves <image> and records what ran before it.
deploy() {
  live_image >>"$(deploy_history)"
  serve_image "$1"
}

# rollback: serves the image that ran before the live one, and drops it from the history.
rollback() {
  history="$(deploy_history)"
  previous="$(tail -n 1 "$history" 2>/dev/null || true)"
  if [ -z "$previous" ]; then
    printf '%s\n' "no earlier deploy to roll back to ($history)" >&2
    return 1
  fi
  serve_image "$previous"
  sed '$d' "$history" >"$history.tmp" && mv "$history.tmp" "$history"
}
