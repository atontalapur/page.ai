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

# Runs a command that should fail, and passes only on exit 1 with the expected message.
# Any other code (125-127 from docker exec, 137 from the OOM killer) means the sandbox
# broke, not that the command failed the way it should.
expect_failure() {
  local message="$1" output code=0
  shift
  output="$("$@" 2>&1)" || code=$?
  [ "$code" = 1 ] || fail "expected exit 1 with '$message', got exit $code: $output"
  [[ "$output" == *"$message"* ]] || fail "exit 1 without '$message': $output"
}

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

# The agent passes repo-relative paths here by mistake. An exit 0 would read as a test
# that passed when it never ran (#65).
expect_failure 'No test files found' \
  sx pnpm --filter @page/demo-app exec vitest run apps/demo-app/src/app/pages.test.tsx
echo "ok: a filter that matches no test files fails"

# A name filter that matches nothing skips every test, which is the same false pass (#66).
sx pnpm --filter @page/demo-app exec vitest run src/shop/money.test.ts -t no-such-test-name \
  && fail "vitest exits 0 when every test is skipped"
echo "ok: a run where every test is skipped fails"
