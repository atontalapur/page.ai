#!/bin/sh
# Rolls back to the deploy before the bad one and waits for it.
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
. "$here/../compose-deploy.sh"
. "$here/../ops.sh"
rollback
wait_healthy
