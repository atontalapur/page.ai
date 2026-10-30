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

# The root filesystem is writable at the Docker level, so what keeps the agent inside
# /workspace is that the sandbox user can write nothing else. List every path it could
# write to (owned by it, group-writable to it, or world-writable) outside /workspace and /tmp.
# -xdev skips /proc, /sys and /dev, which are separate filesystems.
# Symlinks always show mode 777, and find exits non-zero on dirs it can't read (/root),
# which are root-owned anyway.
writable="$(sx sh -c 'find / -xdev \( -path /workspace -o -path /tmp \) -prune -o ! -type l \
  \( -user "$(id -u)" -o \( -group "$(id -g)" -perm -0020 \) -o -perm -0002 \) \
  -print 2>/dev/null; true')"
[ -z "$writable" ] || fail "writable outside /workspace and /tmp: $writable"
sx sh -c 'echo x > /etc/sandbox-probe' 2>/dev/null && fail "wrote to /etc"
echo "ok: nothing outside /workspace and /tmp is writable"

sx sh -c 'echo x > /workspace/.probe && rm /workspace/.probe' || fail "repo is not writable"
echo "ok: /workspace is writable"

sx sh -c 'wget -q -T 3 -O /dev/null http://example.com' 2>/dev/null && fail "network is reachable"
echo "ok: no network"

sx pnpm --filter @page/demo-app test
echo "ok: demo app tests pass offline"
