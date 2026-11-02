#!/bin/sh
# A migration adds cart_items.added_at for abandoned-cart emails. It backfills existing
# lines with a default, then drops the default so new code has to set it, but addItem's
# insert was never updated. Every add to cart violates the not-null constraint and throws.
set -eu
f=apps/demo-app/migrations/002_cart_items_added_at.sql
cat > "$f" <<'SQL'
-- When each cart line was added, for abandoned-cart emails. Existing lines are backfilled
-- with now(); the default is then dropped so writers say when a line was added.
alter table cart_items add column added_at timestamptz not null default now();
alter table cart_items alter column added_at drop default;
SQL
grep -q 'alter column added_at drop default' "$f"
