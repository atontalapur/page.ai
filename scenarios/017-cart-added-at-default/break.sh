#!/bin/sh
# A migration adds cart_items.added_at for abandoned-cart emails. It backfills existing
# lines with a default, then drops the default so new code has to set it, but addItem's
# insert was never updated. Every add to cart violates the not-null constraint and throws.
set -eu
d=apps/demo-app
# The new migration has to sort right after 002 (runtime config, #13). Another migration
# means the code moved.
for m in "$d"/migrations/*.sql; do
  case "${m##*/}" in
  001_init.sql | 002_runtime_config.sql) ;;
  *) echo "unexpected migration $m" >&2; exit 1 ;;
  esac
done
f="$d/migrations/003_cart_items_added_at.sql"
cat > "$f" <<'SQL'
-- When each cart line was added, for abandoned-cart emails. Existing lines are backfilled
-- with now(); the default is then dropped so writers say when a line was added.
alter table cart_items add column added_at timestamptz not null default now();
alter table cart_items alter column added_at drop default;
SQL
grep -q 'alter column added_at drop default' "$f"
