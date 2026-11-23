-- What each run spent on the model, from its run_finished result. Runs recorded before this,
-- and results from a daemon that doesn't send it, count as $0.
alter table runs add column cost_usd real not null default 0 check (cost_usd >= 0);
