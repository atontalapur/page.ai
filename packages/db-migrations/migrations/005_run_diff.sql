-- The agent's `git diff` when a run submits (#136), from the daemon's run_finished job. A
-- Tier 1 run can't push, so this is the only copy of its patch for the reviewer. Null when
-- the run didn't submit or the diff was over the job's cap.
alter table runs add column diff text;
