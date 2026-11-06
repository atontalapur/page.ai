#!/bin/sh
# Builds the demo app from HEAD with bad-deploy.patch on top, which isn't on main, and
# deploys it with the compose stand-in. The patch reads ?limit= as Number(null ?? undefined),
# so GET /api/products without a limit sends NaN to Postgres.
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
. "$here/../compose-deploy.sh"
. "$here/../ops.sh"
build_image page-demo-app:bad-deploy "$here/bad-deploy.patch"
deploy page-demo-app:bad-deploy
wait_healthy
