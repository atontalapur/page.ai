# Sourced by the break-ops.sh, fix-ops.sh and check.sh of the ops scenarios (Tier 3), which
# run on the host against the live demo app (see README.md). Not a scenario: plain files
# in scenarios/ are skipped.

# ops <method> <path> [json body]: calls the demo app's ops API and prints the response.
# Fails on any status that isn't 2xx.
ops() {
  if [ $# -ge 3 ]; then
    curl -sS --fail-with-body -X "$1" -H "authorization: Bearer ${OPS_SECRET:?}" \
      -H 'content-type: application/json' -d "$3" "${DEMO_APP_URL:?}$2"
  else
    curl -sS --fail-with-body -X "$1" -H "authorization: Bearer ${OPS_SECRET:?}" \
      "${DEMO_APP_URL:?}$2"
  fi
  printf '\n'
}

# wait_healthy [seconds]: waits for /api/health to answer 200 (default 90 seconds).
wait_healthy() {
  tries="${1:-90}"
  while [ "$tries" -gt 0 ]; do
    curl -sf -o /dev/null "${DEMO_APP_URL:?}/api/health" && return 0
    tries=$((tries - 1))
    sleep 1
  done
  printf '%s\n' "demo app at $DEMO_APP_URL is not healthy" >&2
  return 1
}

# ops_restart: restarts the app through the ops API, so it rereads runtime config, and
# waits for it to come back. The app exits half a second after its 202, so by the end of
# the sleep the old process is gone and a healthy answer comes from the new one.
ops_restart() {
  ops POST /api/ops/restart >/dev/null
  sleep 3
  wait_healthy
}
