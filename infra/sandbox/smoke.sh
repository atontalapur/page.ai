#!/usr/bin/env bash
# Checks the #5 "Done when" list against a built sandbox image:
#   infra/sandbox/smoke.sh <image>
# Run from the repo root. Starts the container with the same flags the daemon uses.
set -euo pipefail

image="${1:?usage: infra/sandbox/smoke.sh <image>}"
name="$(node apps/node/scripts/sandbox-run.ts "$image")"
trap 'docker stop -t 1 "$name" >/dev/null 2>&1 || true' EXIT

sx() { docker exec "$name" "$@"; }
fail() { echo "FAIL: $*" >&2; exit 1; }

uid="$(sx id -u)"
[ "$uid" != 0 ] || fail "runs as root"
echo "ok: uid $uid"

sx sh -c 'echo x > /etc/sandbox-probe' 2>/dev/null && fail "wrote to /etc"
sx sh -c 'echo x > /sandbox-probe' 2>/dev/null && fail "wrote to /"
echo "ok: root filesystem is read-only"

sx sh -c 'echo x > /workspace/.probe && rm /workspace/.probe' || fail "repo is not writable"
echo "ok: /workspace is writable"

sx sh -c 'wget -q -T 3 -O /dev/null http://example.com' 2>/dev/null && fail "network is reachable"
echo "ok: no network"

sx pnpm --filter @page/demo-app test
echo "ok: demo app tests pass offline"
