#!/bin/sh
# Starts the orchestrator and the demo app, and stops both when either exits.
# DATABASE_URL (required) is the orchestrator's database. The demo app gets its own
# database on the same server, DEMO_DATABASE_URL, which defaults to DATABASE_URL with
# the database name swapped for "demo". SEED_DEMO=0 skips reseeding demo products.
set -eu
: "${DATABASE_URL:?DATABASE_URL is required}"
DEMO_DATABASE_URL="${DEMO_DATABASE_URL:-$(printf '%s' "$DATABASE_URL" | sed -E 's|/[^/?]*(\?.*)?$|/demo\1|')}"

cd /app/demo
DATABASE_URL="$DEMO_DATABASE_URL" node scripts/db.ts migrate
if [ "${SEED_DEMO:-1}" != 0 ]; then
  DATABASE_URL="$DEMO_DATABASE_URL" node scripts/db.ts seed
fi

(cd /app/orchestrator/apps/orchestrator \
  && PORT=4000 exec node --enable-source-maps dist/apps/orchestrator/src/main.js) &
orchestrator=$!
(cd /app/demo && DATABASE_URL="$DEMO_DATABASE_URL" PORT=3000 exec node_modules/.bin/next start) &
demo=$!

stop() { kill -TERM "$orchestrator" "$demo" 2>/dev/null || true; }
trap stop INT TERM
while kill -0 "$orchestrator" 2>/dev/null && kill -0 "$demo" 2>/dev/null; do sleep 1; done
stop
wait
